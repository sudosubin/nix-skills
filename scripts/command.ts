import { program } from "commander";
import { cloneRepository, openRepository } from "es-git";
import {
  groupBy,
  memoize,
  orderBy,
  retry,
  sortBy,
  uniqBy,
} from "es-toolkit";
import fg from "fast-glob";
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

const limit = pLimit(10);
const root = path.join(import.meta.dirname, "..", "data");

const paths = {
  byName: path.join(root, "by-name"),
  shard: path.join(root, "shard"),
  sourceCustom: path.join(root, "source-custom.json"),
  sourceSkillsSh: path.join(root, "source-skills-sh.json"),
  sourceSkillsDir: path.join(root, "source-skillsdirectory-com.json"),
  cloneCache: "/tmp/nix-skills-git-clone-cache",
};

const skillsDirectoryPatterns = [
  /^(?:\.|(?:\.\/)?[^/]+)$/,
  /^skills(?:\/|$)/,
  /^skills\/\.curated(?:\/|$)/,
  /^skills\/\.experimental(?:\/|$)/,
  /^skills\/\.system(?:\/|$)/,
  /^\.agent\/skills(?:\/|$)/,
  /^\.agents\/skills(?:\/|$)/,
  /^\.claude\/skills(?:\/|$)/,
  /^\.cline\/skills(?:\/|$)/,
  /^\.codebuddy\/skills(?:\/|$)/,
  /^\.codex\/skills(?:\/|$)/,
  /^\.commandcode\/skills(?:\/|$)/,
  /^\.continue\/skills(?:\/|$)/,
  /^\.github\/skills(?:\/|$)/,
  /^\.goose\/skills(?:\/|$)/,
  /^\.iflow\/skills(?:\/|$)/,
  /^\.junie\/skills(?:\/|$)/,
  /^\.kilocode\/skills(?:\/|$)/,
  /^\.kiro\/skills(?:\/|$)/,
  /^\.mux\/skills(?:\/|$)/,
  /^\.neovate\/skills(?:\/|$)/,
  /^\.opencode\/skills(?:\/|$)/,
  /^\.openhands\/skills(?:\/|$)/,
  /^\.pi\/skills(?:\/|$)/,
  /^\.qoder\/skills(?:\/|$)/,
  /^\.roo\/skills(?:\/|$)/,
  /^\.trae\/skills(?:\/|$)/,
  /^\.windsurf\/skills(?:\/|$)/,
  /^\.zencoder\/skills(?:\/|$)/,
];

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

const fetchJson = async <T>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
};

async function* paginateSkillsSh() {
  for (let page = 0; ; page++) {
    console.log(`[INFO] fetching skills.sh view=all-time page=${page}`);
    const { skills } = await retry(
      () =>
        fetchJson<{ skills: { skillId: string; source: string }[] }>(
          `https://skills.sh/api/skills/all-time/${page}`,
        ),
      { retries: 3, delay: 1000 },
    );
    if (skills.length === 0) {
      break;
    }
    yield* skills.map(({ source }) => `github:${source}`);
  }
}

async function* paginateSkillsDirectoryCom() {
  for (let page = 1; ; page++) {
    console.log(`[INFO] fetching skillsdirectory.com page=${page}`);
    const { skills } = await retry(
      () =>
        fetchJson<{
          skills: {
            name: string;
            githubRepoFullName: string;
            skillFilePath: string;
          }[];
        }>(`https://www.skillsdirectory.com/api/skills?page=${page}`),
      { retries: 3, delay: 1000 },
    );
    if (skills.length === 0) {
      break;
    }
    yield* skills.map(
      ({ githubRepoFullName }) => `github:${githubRepoFullName}`,
    );
  }
}

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

const getRevUsingGh = memoize(async (source: string) => {
  try {
    const { stdout } = await exec(
      `gh api "repos/${source}/commits/HEAD" --jq '.sha'`,
      { timeout: 10000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
});

const getRevUsingGit = memoize(async (source: string) => {
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
});

const cloneGitRepository = memoize(async (source: string) => {
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
});

const nixPrefetch = memoize(
  async ({ source, rev }: { source: string; rev: string }) => {
    const url = `https://github.com/${source}/archive/${rev}.tar.gz`;
    try {
      const { stdout } = await retry(
        () =>
          exec(`nix-prefetch-url --print-path --unpack "${url}" 2>/dev/null`),
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
  },
);

const findAllSkills = async (storePath: string): Promise<string[]> => {
  const pattern = path.join(storePath, "**/SKILL.md");
  const files = await fg.async(pattern, { dot: true });
  return files.map((file) => path.relative(storePath, file));
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
    const previous = await readAllRepoSkills();
    const previousMap = new Map(previous.map((s) => [s.source, s]));

    const data = (
      await Promise.all(
        repos.map((source) =>
          limit(async () => {
            const prev = previousMap.get(source);
            return update({ source, prev });
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
