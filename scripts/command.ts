import { program } from "commander";
import { cloneRepository, openRepository } from "es-git";
import {
  groupBy,
  uniqBy,
  retry,
  sortBy,
  flatten,
  flow,
  memoize,
} from "es-toolkit";
import fg from "fast-glob";
import pLimit from "p-limit";
import childProcess from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import matter from "gray-matter";

const exec = promisify(childProcess.exec);

interface SourceSkill {
  name: string;
  source: string;
  path?: string;
}

interface Skill {
  pname: string;
  source: {
    type: string;
    owner: string;
    repo: string;
    rev: string;
    hash: string;
  };
  path: string;
  lastUpdated: string;
}

const limit = pLimit(10);
const root = path.join(import.meta.dirname, "..", "data");

const paths = {
  skills: path.join(root, "skills.json"),
  shard: path.join(root, "shard"),
  sourceSkillsSh: path.join(root, "source-skills-sh.json"),
  sourceSkillsDir: path.join(root, "source-skillsdirectory-com.json"),
  cloneCache: "/tmp/nix-skills-git-clone-cache",
};

const chunk = <T>(input: T[], index: number, size: number): T[] => {
  const unit = Math.ceil(input.length / size);
  return input.slice(index * unit, (index + 1) * unit);
};

const collect = async (gen: AsyncGenerator<SourceSkill>) => {
  const items: SourceSkill[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return sortBy(items, ["source", "name"]);
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
  for (let offset = 0; ; offset += 100) {
    console.log(`[INFO] fetching skills.sh offset=${offset}`);
    const { skills } = await retry(
      () =>
        fetchJson<{ skills: { name: string; source: string }[] }>(
          `https://skills.sh/api/skills?limit=100&offset=${offset}`,
        ),
      { retries: 3, delay: 1000 },
    );
    if (skills.length === 0) {
      break;
    }
    yield* skills.map(({ name, source }) => ({ name, source }));
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
    yield* skills.map(({ name, githubRepoFullName, skillFilePath }) => ({
      name,
      source: githubRepoFullName,
      path: skillFilePath,
    }));
  }
}

const update = async (input: SourceSkill & { prev?: Skill }) => {
  const { name, source, prev } = input;
  const [owner, repo] = source.split("/", 2) as [string, string];

  const rev = (await getRevUsingGh(source)) || (await getRevUsingGit(source));
  if (!rev) {
    return null;
  }
  if (prev && rev === prev.source.rev) {
    return prev;
  }

  const { hash, storePath } = await nixPrefetch({ source, rev });
  const skillPath = await findSkill({ storePath, name });
  if (!skillPath) {
    console.info(`[WARN] skill ${name} not found in ${source}`);
    return null;
  }

  const skillDir = path.dirname(skillPath);

  return {
    pname: `${owner}.${repo}.${path.basename(skillDir)}`,
    source: { type: "github", owner, repo, rev, hash },
    path: skillDir,
    lastUpdated: new Date().toISOString(),
  } satisfies Skill;
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
  const repository = await openRepository(clonePath);
  return repository.revparseSingle("HEAD");
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
    }
    throw error;
  }
});

const nixPrefetch = memoize(
  async ({ source, rev }: { source: string; rev: string }) => {
    const url = `https://github.com/${source}/archive/${rev}.tar.gz`;
    const { stdout } = await exec(
      `nix-prefetch-url --print-path --unpack "${url}" 2>/dev/null`,
    );
    const [hash, storePath] = stdout.trim().split("\n");
    return { hash: hash!, storePath: storePath! };
  },
);

const findSkill = memoize(
  async ({ storePath, name }: { storePath: string; name: string }) => {
    // find by directory name
    const patternByDir = path.join(storePath, `**/${name}/SKILL.md`);
    for (const file of await fg.async(patternByDir, { dot: true })) {
      return path.relative(storePath, file);
    }

    // find by frontmatter name
    const patternByFrontmatter = path.join(storePath, "**/SKILL.md");
    for (const file of await fg.async(patternByFrontmatter, { dot: true })) {
      const content = await fs.readFile(file, "utf-8");
      try {
        const { data } = matter(content);
        if (data.name?.toLowerCase() === name.toLowerCase()) {
          return path.relative(storePath, file);
        }
      } catch {
        continue;
      }
    }

    return null;
  },
);

program
  .command("fetch <source>")
  .description("fetch skill list from source (skills.sh, skillsdirectory.com)")
  .action(async (source: string) => {
    if (source === "skills.sh") {
      const skills = await collect(paginateSkillsSh());
      await writeJson(paths.sourceSkillsSh, skills);
      console.log(`[INFO] wrote ${skills.length} skills`);
    } else if (source === "skillsdirectory.com") {
      const skills = await collect(paginateSkillsDirectoryCom());
      await writeJson(paths.sourceSkillsDir, skills);
      console.log(`[INFO] wrote ${skills.length} skills`);
    } else {
      console.error(`[ERROR] unknown source: ${source}`);
      process.exit(1);
    }
  });

program
  .command("update [shard]")
  .description("update skills from fetched data (shard format: index/total)")
  .action(async (shard: string = "1/1") => {
    const sourcesByRepo = flow(
      (sets: SourceSkill[][]) => flatten(sets),
      (sources) => uniqBy(sources, (s) => `${s.source}.${s.name}`),
      (sources) => groupBy(sources, (s) => s.source),
    )(
      await Promise.all([
        readJson<SourceSkill[]>(paths.sourceSkillsSh),
        readJson<SourceSkill[]>(paths.sourceSkillsDir),
      ]),
    );

    console.log(`[INFO] update shard: ${shard}`);
    const [index, size] = shard.split("/").map((v) => Number.parseInt(v));
    if (index === undefined || size === undefined) {
      throw new Error(`invalid shard: ${shard}`);
    }

    const repos = chunk(Object.keys(sourcesByRepo), index - 1, size);
    console.log(`[INFO] load sharded repos: ${repos.length}`);
    const previous = await readJson<Skill[]>(paths.skills);

    const data = (
      await Promise.all(
        repos.map((repo) =>
          limit(async () => {
            const skills: (Skill | null)[] = [];
            for (const { name, source, path } of sourcesByRepo[repo] || []) {
              const prev = previous.find(
                ({ source: s }) => `${s.owner}/${s.repo}` === source,
              );
              skills.push(await update({ name, source, path, prev }));
            }
            return flow(
              (skills: (Skill | null)[]) => skills.filter((s) => s !== null),
              (skills) => uniqBy(skills, (s) => s.pname),
              (skills) => sortBy(skills, ["pname"]),
            )(skills);
          }),
        ),
      )
    ).flat();
    await writeJson(path.join(paths.shard, `${index}.json`), data);
  });

program
  .command("combine")
  .description("combine sharded files into one")
  .action(async () => {
    const files = await fs.readdir(paths.shard).catch(() => []);
    if (files.length === 0) {
      console.error("[ERROR] No shard files found");
      process.exit(1);
    }

    const shards = await Promise.all(
      files.map((f) => readJson<Skill[]>(path.join(paths.shard, f))),
    );
    const all = shards.flat();
    const unique = uniqBy(all, (s) => s.pname);
    const sorted = unique.sort((a, b) => a.pname.localeCompare(b.pname));

    await writeJson(paths.skills, sorted);
    console.log(`[INFO] combined ${sorted.length} skills`);

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
