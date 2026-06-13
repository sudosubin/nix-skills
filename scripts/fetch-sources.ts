import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { program } from "commander";
import ky from "ky";

const root = path.join(import.meta.dirname, "..", "data");

const sources = {
  "skills.sh": {
    path: path.join(root, "source-skills-sh.json"),
    async *paginate() {
      const api = ky.create({ retry: { limit: 5 }, timeout: 30_000 });
      for (let page = 0; ; page++) {
        console.log(`[INFO] fetching skills.sh page=${page}`);
        const { skills } = await api
          .get(`https://skills.sh/api/skills/all-time/${page}`)
          .json<{ skills: { source: string }[] }>();
        if (skills.length === 0) break;
        yield* skills.map(({ source }) => `github:${source}`);
      }
    },
  },
  "skillsdirectory.com": {
    path: path.join(root, "source-skillsdirectory-com.json"),
    async *paginate() {
      const api = ky.create({ retry: { limit: 5 }, timeout: 120_000 });
      for (let page = 1; ; page++) {
        console.log(`[INFO] fetching skillsdirectory.com page=${page}`);
        const { skills } = await api
          .get(`https://www.skillsdirectory.com/api/skills?page=${page}`)
          .json<{ skills: { githubRepoFullName: string }[] }>();
        if (skills.length === 0) break;
        yield* skills.map(
          ({ githubRepoFullName }) => `github:${githubRepoFullName}`,
        );
      }
    },
  },
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

program
  .command("fetch <source>")
  .description("fetch skill list from source (skills.sh, skillsdirectory.com)")
  .action(async (name: string) => {
    const source = sources[name as keyof typeof sources];
    if (!source) {
      console.error(`[ERROR] unknown source: ${name}`);
      process.exit(1);
    }

    const previous = await readJson<string[]>(source.path);
    const fetched: string[] = [];
    for await (const item of source.paginate()) {
      fetched.push(item);
    }

    const unique = [...new Set(fetched)];
    const merged = [...new Set([...unique, ...previous])].sort();
    await writeJson(source.path, merged);
    console.log(
      `[INFO] ${name}: wrote ${merged.length} sources (fetched=${unique.length}, added=${unique.filter((s) => !previous.includes(s)).length})`,
    );
  });

await program.parseAsync();
