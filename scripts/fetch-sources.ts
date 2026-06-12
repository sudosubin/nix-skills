import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { program } from "commander";
import ky from "ky";

const root = path.join(import.meta.dirname, "..", "data");

const paths = {
  sourceSkillsSh: path.join(root, "source-skills-sh.json"),
  sourceSkillsDir: path.join(root, "source-skillsdirectory-com.json"),
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
        .get(`https://www.skillsdirectory.com/api/skills?page=${page}`, {
          timeout: 120_000,
        })
        .json<{
          skills: {
            name: string;
            githubRepoFullName: string;
            skillFilePath: string;
          }[];
        }>();
      return skills.map(
        ({ githubRepoFullName }) => `github:${githubRepoFullName}`,
      );
    },
    1,
  );

const collectSources = async (gen: AsyncGenerator<string>) => {
  const items: string[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return [...new Set(items)].sort();
};

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

await program.parseAsync();
