import childProcess from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { program } from "commander";
import { cloneRepository, openRepository } from "es-git";
import { groupBy, orderBy, retry, sortBy, uniqBy } from "es-toolkit";
import pLimit from "p-limit";

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

const ownerOf = (source: string) => source.split(":")[1]?.split("/")[0] ?? "";
const prefixOf = (source: string) => ownerOf(source).charAt(0).toLowerCase();
const repoOf = (source: string) => source.split(":")[1]?.split("/")[1] ?? "";
const ownerRepoOf = (source: string) => source.split(":")[1] ?? "";

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

const readSkillsForSources = async (
  sources: string[],
): Promise<RepoSkills[]> => {
  const prefixes = [...new Set(sources.map(prefixOf))];
  const results = await Promise.all(
    prefixes.map((p) =>
      readJson<RepoSkills[]>(path.join(paths.byName, p, "skills.json")),
    ),
  );
  return results.flat();
};

const readAllSkills = async (): Promise<RepoSkills[]> => {
  const dirs = await fs.readdir(paths.byName).catch(() => []);
  const results = await Promise.all(
    dirs.map((d) =>
      readJson<RepoSkills[]>(path.join(paths.byName, d, "skills.json")),
    ),
  );
  return results.flat();
};

const chunk = <T>(input: T[], index: number, size: number): T[] => {
  const unit = Math.ceil(input.length / size);
  return input.slice(index * unit, (index + 1) * unit);
};

const selectCanonicalSkills = (repo: string, skillPaths: string[]) => {
  const getPathPriority = (skillDir: string) => {
    const i = skillsDirectoryPatterns.findIndex((p) => p.test(skillDir));
    return i >= 0 ? i : 10_000;
  };

  return uniqBy(
    orderBy(
      skillPaths.map((skillPath) => {
        const skillDir = path.dirname(skillPath).replace(/\/+$/, "") || ".";
        return {
          skillName: skillDir === "." ? repo : path.basename(skillDir),
          skillDir,
          pathPriority: getPathPriority(skillDir),
          pathDepth: skillDir === "." ? 0 : skillDir.split("/").length,
        };
      }),
      ["pathPriority", "pathDepth", "skillDir"],
      ["asc", "asc", "asc"],
    ),
    (c) => c.skillName,
  );
};

const getRev = async (ownerRepo: string): Promise<string | null> => {
  try {
    const { stdout } = await exec(
      `gh api "repos/${ownerRepo}/commits/HEAD" --jq '.sha'`,
      { timeout: 10000 },
    );
    if (stdout.trim()) return stdout.trim();
  } catch {}

  const clonePath = path.join(paths.cloneCache, ownerRepo.replace("/", "--"));
  await fs.rm(clonePath, { recursive: true, force: true });
  try {
    await cloneRepository(`https://github.com/${ownerRepo}.git`, clonePath, {
      fetch: { depth: 1, downloadTags: "None" },
    });
    const repo = await openRepository(clonePath);
    return repo.revparseSingle("HEAD");
  } catch (error) {
    console.error(`[WARN] failed to get rev for ${ownerRepo}: ${error}`);
    const msg = `${error}`;
    if (
      msg.includes("remote authentication required") ||
      msg.includes("unexpected http status code")
    ) {
      return null;
    }
    throw error;
  }
};

const nixPrefetch = async (ownerRepo: string, rev: string) => {
  const url = `https://github.com/${ownerRepo}/archive/${rev}.tar.gz`;
  try {
    const { stdout } = await retry(
      () => exec(`nix-prefetch-url --print-path --unpack "${url}" 2>/dev/null`),
      { retries: 3, delay: 1000 },
    );
    const [hash, storePath] = stdout.trim().split("\n");
    return hash && storePath ? { hash, storePath } : null;
  } catch (error) {
    console.error(`[WARN] nix-prefetch-url failed for ${ownerRepo}: ${error}`);
    return null;
  }
};

const findAllSkills = async (storePath: string): Promise<string[]> => {
  const results: string[] = [];
  const walk = async (absDir: string, relDir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skillSearchIgnoreDirs.has(entry.name)) {
          await walk(
            path.join(absDir, entry.name),
            relDir ? `${relDir}/${entry.name}` : entry.name,
          );
        }
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        results.push(relDir ? `${relDir}/SKILL.md` : "SKILL.md");
      }
    }
  };
  await walk(storePath, "");
  return results;
};

const updateRepo = async (
  source: string,
  prev?: RepoSkills,
): Promise<RepoSkills | null> => {
  const ownerRepo = ownerRepoOf(source);
  const repo = repoOf(source);
  console.log(`[INFO] processing ${source}`);

  const rev = await getRev(ownerRepo);
  if (!rev || prev?.rev === rev) return null;

  const prefetch = await nixPrefetch(ownerRepo, rev);
  if (!prefetch) return null;

  const skillPaths = await findAllSkills(prefetch.storePath);
  if (skillPaths.length === 0) {
    console.warn(`[WARN] no skills found in ${ownerRepo}`);
    return null;
  }

  return {
    source,
    rev,
    hash: prefetch.hash,
    skills: selectCanonicalSkills(repo, skillPaths)
      .map(({ skillDir }) => skillDir)
      .sort(),
    lastUpdated: new Date().toISOString(),
  };
};

program
  .command("update [shard]")
  .description("update skills from fetched data (shard format: index/total)")
  .action(async (shard = "1/1") => {
    const raws = await Promise.all([
      readJson<string[]>(paths.sourceCustom),
      readJson<string[]>(paths.sourceSkillsSh),
      readJson<string[]>(paths.sourceSkillsDir),
    ]);
    const sources = [...new Set(raws.flat())].sort();

    const [index, size] = shard
      .split("/")
      .map((v: string) => Number.parseInt(v, 10));
    if (!index || !size) throw new Error(`invalid shard: ${shard}`);
    console.log(`[INFO] update shard: ${shard}`);

    const repos = chunk(sources, index - 1, size);
    const previousMap = new Map(
      (await readSkillsForSources(repos)).map((s) => [s.source, s]),
    );

    const data = (
      await Promise.all(
        repos.map((source) =>
          limit(async () => {
            const result = await updateRepo(source, previousMap.get(source));
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

    const existingMap = new Map(
      (await readAllSkills()).map((s) => [s.source, s]),
    );

    const shards = await Promise.all(
      files.map((f) => readJson<RepoSkills[]>(path.join(paths.shard, f))),
    );
    for (const repo of shards.flat()) existingMap.set(repo.source, repo);

    const allRepos = Array.from(existingMap.values());
    const byPrefix = groupBy(allRepos, (s) => prefixOf(s.source));
    for (const [prefix, repos] of Object.entries(byPrefix)) {
      await writeJson(
        path.join(paths.byName, prefix, "skills.json"),
        sortBy(repos, [(s) => s.source]),
      );
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
    console.log("[INFO] cleaned cache");
  });

await program.parseAsync();
