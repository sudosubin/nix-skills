import { program } from "commander";
import { cloneRepository, openRepository } from "es-git";
import { groupBy, orderBy, retry, sortBy, uniqBy } from "es-toolkit";
import ky from "ky";
import pLimit from "p-limit";
import childProcess from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(childProcess.exec);

interface RepoSkills {
  source: string;
  rev: string;
  hash: string;
  skills: string[];
  lastUpdated: string;
}

const limit = pLimit(2);
const root = path.join(import.meta.dirname, "..", "data");

const paths = {
  byName: path.join(root, "by-name"),
  shard: path.join(root, "shard"),
  sourceCustom: path.join(root, "source-custom.json"),
  sourceSkillsSh: path.join(root, "source-skills-sh.json"),
  sourceSkillsDir: path.join(root, "source-skillsdirectory-com.json"),
  cloneCache: "/tmp/nix-skills-git-clone-cache",
};

const skillToolDirs = [
  "agent",
  "agents",
  "claude",
  "cline",
  "codebuddy",
  "codex",
  "commandcode",
  "continue",
  "github",
  "goose",
  "iflow",
  "junie",
  "kilocode",
  "kiro",
  "mux",
  "neovate",
  "opencode",
  "openhands",
  "pi",
  "qoder",
  "roo",
  "trae",
  "windsurf",
  "zencoder",
];

const skillsDirectoryPatterns = [
  /^(?:\.|(?:\.\/)?[^/]+)$/,
  /^skills(?:\/|$)/,
  /^skills\/\.curated(?:\/|$)/,
  /^skills\/\.experimental(?:\/|$)/,
  /^skills\/\.system(?:\/|$)/,
  ...skillToolDirs.map((tool) => new RegExp(`^\\.${tool}/skills(?:/|$)`)),
];

const skillSearchIgnoreDirs = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".cache",
  "coverage",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".gradle",
  ".idea",
  ".bundle",
  ".pnpm-store",
  "bin",
  "obj",
  "Pods",
  "DerivedData",
]);

const getPathPriority = (skillDir: string): number => {
  const index = skillsDirectoryPatterns.findIndex((pattern) =>
    pattern.test(skillDir),
  );
  return index >= 0 ? index : 10_000;
};

const selectCanonicalSkills = (repo: string, skillPaths: string[]) => {
  const sorted = orderBy(
    skillPaths.map((skillPath) => {
      const skillDir = path.dirname(skillPath).replace(/\/+$/, "") || ".";
      const skillName = skillDir === "." ? repo : path.basename(skillDir);
      const pathPriority = getPathPriority(skillDir);
      const pathDepth = skillDir === "." ? 0 : skillDir.split("/").length;
      return { skillName, skillDir, pathPriority, pathDepth };
    }),
    ["pathPriority", "pathDepth", "skillDir"],
    ["asc", "asc", "asc"],
  );

  return uniqBy(sorted, (c) => c.skillName);
};

const parseSource = (
  source: string,
): { type: string; owner: string; repo: string } => {
  const [type, ownerRepo] = source.split(":", 2) as [string, string];
  const [owner, repo] = ownerRepo.split("/", 2) as [string, string];
  return { type, owner, repo };
};

const getSourcePrefix = (source: string): string => {
  const { owner } = parseSource(source);
  return owner.charAt(0).toLowerCase();
};

const readAllRepoSkills = async (): Promise<RepoSkills[]> => {
  const dirs = await fs.readdir(paths.byName).catch(() => []);
  const skills = await Promise.all(
    dirs.map((dir) =>
      readJson<RepoSkills[]>(path.join(paths.byName, dir, "skills.json")),
    ),
  );
  return skills.flat();
};

const readRepoSkillsForSources = async (
  sources: string[],
): Promise<RepoSkills[]> => {
  const prefixes = [...new Set(sources.map(getSourcePrefix))];
  const skills = await Promise.all(
    prefixes.map((prefix) =>
      readJson<RepoSkills[]>(path.join(paths.byName, prefix, "skills.json")),
    ),
  );
  return skills.flat();
};

const chunk = <T>(input: T[], index: number, size: number): T[] => {
  const unit = Math.ceil(input.length / size);
  return input.slice(index * unit, (index + 1) * unit);
};

const collectSources = async (gen: AsyncGenerator<string>) => {
  const items: string[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return [...new Set(items)].sort();
};

const readJson = async <T>(file: string): Promise<T> => {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
  } catch {
    return [] as T;
  }
};

const writeJson = async (file: string, data: unknown) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + os.EOL);
};

const api = ky.create({ retry: { limit: 5 }, timeout: 30_000 });

async function* paginate<T>(
  label: string,
  getPage: (page: number) => Promise<T[]>,
  startPage = 0,
): AsyncGenerator<T> {
  for (let page = startPage; ; page++) {
    console.log(`[INFO] fetching ${label} page=${page}`);
    const items = await getPage(page);
    if (items.length === 0) break;
    yield* items;
  }
}

const paginateSkillsSh = () =>
  paginate("skills.sh view=all-time", async (page) => {
    const { skills } = await api
      .get(`https://skills.sh/api/skills/all-time/${page}`)
      .json<{ skills: { skillId: string; source: string }[] }>();
    return skills.map(({ source }) => `github:${source}`);
  });

const paginateSkillsDirectoryCom = () =>
  paginate(
    "skillsdirectory.com",
    async (page) => {
      const { skills } = await api
        .get(`https://www.skillsdirectory.com/api/skills?page=${page}`)
        .json<{
          skills: {
            name: string;
            githubRepoFullName: string;
            skillFilePath: string;
          }[];
        }>();
      return skills.map(({ githubRepoFullName }) => `github:${githubRepoFullName}`);
    },
    1,
  );

const fetchAndMergeSources = async (
  sourceName: string,
  sourcePath: string,
  generator: AsyncGenerator<string>,
) => {
  const previous = await readJson<string[]>(sourcePath);
  const fetched = await collectSources(generator);

  const merged = [...new Set([...fetched, ...previous])].sort();
  const added = fetched.filter((s) => !previous.includes(s));
  const preserved = previous.filter((s) => !fetched.includes(s));

  await writeJson(sourcePath, merged);
  console.log(
    `[INFO] ${sourceName}: wrote ${merged.length} sources (fetched=${fetched.length}, added=${added.length}, preserved=${preserved.length})`,
  );
};

const update = async (input: {
  source: string;
  prev?: RepoSkills;
}): Promise<RepoSkills | null> => {
  const { source, prev } = input;
  const { owner, repo } = parseSource(source);

  console.log(`[INFO] processing ${source}`);

  const rev =
    (await getRevUsingGh(`${owner}/${repo}`)) ||
    (await getRevUsingGit(`${owner}/${repo}`));
  if (!rev) {
    return null;
  }
  if (prev?.rev === rev) {
    return null;
  }

  const prefetch = await nixPrefetch({ source: `${owner}/${repo}`, rev });
  if (!prefetch) {
    return null;
  }

  const { hash, storePath } = prefetch;
  const skillPaths = await findAllSkills(storePath);
  if (skillPaths.length === 0) {
    console.info(`[WARN] no skills found in ${owner}/${repo}`);
    return null;
  }

  const selected = selectCanonicalSkills(repo, skillPaths);

  return {
    source,
    rev,
    hash,
    skills: selected.map(({ skillDir }) => skillDir).sort(),
    lastUpdated: new Date().toISOString(),
  };
};

const getRevUsingGh = async (source: string): Promise<string | null> => {
  try {
    const { stdout } = await exec(
      `gh api "repos/${source}/commits/HEAD" --jq '.sha'`,
      { timeout: 10000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

const getRevUsingGit = async (source: string): Promise<string | null> => {
  const clonePath = await cloneGitRepository(source);
  if (!clonePath) {
    return null;
  }

  try {
    const repository = await openRepository(clonePath);
    return repository.revparseSingle("HEAD");
  } catch {
    console.error(`[WARN] failed to get rev using git for ${source}`);
    return null;
  }
};

const cloneGitRepository = async (source: string): Promise<string | null> => {
  const clonePath = path.join(paths.cloneCache, `${source.replace("/", "--")}`);
  await fs.rm(clonePath, { recursive: true, force: true });

  try {
    await cloneRepository(`https://github.com/${source}.git`, clonePath, {
      fetch: { depth: 1, downloadTags: "None" },
    });
    return clonePath;
  } catch (error) {
    console.error(`[WARN] failed to clone ${source}: ${error}`);
    if (`${error}`.includes("remote authentication required")) {
      return null;
    } else if (`${error}`.includes("unexpected http status code")) {
      return null;
    }
    throw error;
  }
};

const nixPrefetch = async ({
  source,
  rev,
}: {
  source: string;
  rev: string;
}): Promise<{ hash: string; storePath: string } | null> => {
  const url = `https://github.com/${source}/archive/${rev}.tar.gz`;
  try {
    const { stdout } = await retry(
      () => exec(`nix-prefetch-url --print-path --unpack "${url}" 2>/dev/null`),
      { retries: 3, delay: 1000 },
    );
    const [hash, storePath] = stdout.trim().split("\n");
    if (!hash || !storePath) {
      return null;
    }
    return { hash, storePath };
  } catch (error) {
    console.error(`[WARN] nix-prefetch-url failed for ${source}: ${error}`);
    return null;
  }
};

const findAllSkills = async (storePath: string): Promise<string[]> => {
  const results: string[] = [];

  const walk = async (absDir: string, relDir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skillSearchIgnoreDirs.has(entry.name)) continue;
        const nextRel = relDir ? `${relDir}/${entry.name}` : entry.name;
        await walk(path.join(absDir, entry.name), nextRel);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        results.push(relDir ? `${relDir}/SKILL.md` : "SKILL.md");
      }
    }
  };

  await walk(storePath, "");
  return results;
};

program
  .command("fetch <source>")
  .description("fetch skill list from source (skills.sh, skillsdirectory.com)")
  .action(async (source: string) => {
    if (source === "skills.sh") {
      await fetchAndMergeSources(
        "skills.sh",
        paths.sourceSkillsSh,
        paginateSkillsSh(),
      );
    } else if (source === "skillsdirectory.com") {
      await fetchAndMergeSources(
        "skillsdirectory.com",
        paths.sourceSkillsDir,
        paginateSkillsDirectoryCom(),
      );
    } else {
      console.error(`[ERROR] unknown source: ${source}`);
      process.exit(1);
    }
  });

program
  .command("update [shard]")
  .description("update skills from fetched data (shard format: index/total)")
  .action(async (shard: string = "1/1") => {
    const raws = await Promise.all([
      readJson<string[]>(paths.sourceCustom),
      readJson<string[]>(paths.sourceSkillsSh),
      readJson<string[]>(paths.sourceSkillsDir),
    ]);
    const sources = [...new Set(raws.flat())].sort();

    console.log(`[INFO] update shard: ${shard}`);
    const [index, size] = shard.split("/").map((v) => Number.parseInt(v));
    if (index === undefined || size === undefined) {
      throw new Error(`invalid shard: ${shard}`);
    }

    const repos = chunk(sources, index - 1, size);
    console.log(`[INFO] load sharded repos: ${repos.length}`);
    const previous = await readRepoSkillsForSources(repos);
    const previousMap = new Map(previous.map((s) => [s.source, s]));

    const data = (
      await Promise.all(
        repos.map((source) =>
          limit(async () => {
            const prev = previousMap.get(source);
            const result = await update({ source, prev });
            global.gc?.();
            return result;
          }),
        ),
      )
    )
      .filter((v): v is RepoSkills => v !== null)
      .sort((a, b) => a.source.localeCompare(b.source));
    await writeJson(path.join(paths.shard, `${index}.json`), data);
  });

program
  .command("combine")
  .description("combine sharded files into by-name structure")
  .action(async () => {
    const files = await fs.readdir(paths.shard).catch(() => []);
    if (files.length === 0) {
      console.error("[ERROR] No shard files found");
      process.exit(1);
    }

    // Read existing repo skills from by-name first
    const existing = await readAllRepoSkills();
    const existingMap = new Map(existing.map((s) => [s.source, s]));

    // Read all shard files and override existing by source
    const shards = await Promise.all(
      files.map((f) => readJson<RepoSkills[]>(path.join(paths.shard, f))),
    );
    for (const repo of shards.flat()) {
      existingMap.set(repo.source, repo);
    }

    // Group by source prefix and write to by-name structure
    const allRepos = Array.from(existingMap.values());
    const byPrefix = groupBy(allRepos, (s) => getSourcePrefix(s.source));

    for (const [prefix, repos] of Object.entries(byPrefix)) {
      const sorted = sortBy(repos, [(s) => s.source]);
      await writeJson(path.join(paths.byName, prefix, "skills.json"), sorted);
    }

    console.log(
      `[INFO] combined ${allRepos.length} repos into ${Object.keys(byPrefix).length} prefixes`,
    );

    await fs.rm(paths.shard, { recursive: true, force: true });
  });

program
  .command("clean-cache")
  .description("clean git clone cache")
  .action(async () => {
    await fs.rm(paths.cloneCache, { recursive: true, force: true });
    console.log(`[INFO] cleaned cache`);
  });

await program.parseAsync();
