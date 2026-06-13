import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { program } from "commander";
import { XMLParser } from "fast-xml-parser";
import ky from "ky";

const root = path.join(import.meta.dirname, "..", "data");

const api = ky.create({ retry: { limit: 5 }, timeout: 120_000 });

const xmlParser = new XMLParser({
  isArray: (name) => name === "sitemap" || name === "url",
});

const locsOf = (xml: string): string[] => {
  const doc = xmlParser.parse(xml) as {
    sitemapindex?: { sitemap?: { loc?: string }[] };
    urlset?: { url?: { loc?: string }[] };
  };
  const entries = doc.sitemapindex?.sitemap ?? doc.urlset?.url ?? [];
  return entries.flatMap((e) => (e.loc ? [e.loc] : []));
};

const sources = {
  "skills.sh": {
    path: path.join(root, "source-skills-sh.json"),
    async fetch(): Promise<string[]> {
      const base = "https://www.skills.sh";
      const index = await api.get(`${base}/sitemap.xml`).text();
      const sitemaps = locsOf(index).filter((u) =>
        /\/sitemap-(owners|skills)/.test(u),
      );

      const repos: string[] = [];
      for (const sitemap of sitemaps) {
        console.log(`[INFO] fetching ${sitemap}`);
        const xml = await api.get(sitemap).text();
        for (const loc of locsOf(xml)) {
          const [owner, repo] = new URL(loc).pathname.slice(1).split("/");
          // GitHub owner logins never contain dots; skip non-GitHub sources.
          if (owner && repo && !owner.includes(".")) {
            repos.push(`github:${owner}/${repo}`);
          }
        }
      }
      return repos;
    },
  },
  "skillsdirectory.com": {
    path: path.join(root, "source-skillsdirectory-com.json"),
    async fetch(): Promise<string[]> {
      const repos: string[] = [];
      for (let page = 1; ; page++) {
        console.log(`[INFO] fetching skillsdirectory.com page=${page}`);
        const { skills, pagination } = await api
          .get(`https://www.skillsdirectory.com/api/skills?page=${page}`)
          .json<{
            skills: { githubRepoFullName: string }[];
            pagination: { hasNextPage: boolean };
          }>();
        repos.push(...skills.map((s) => `github:${s.githubRepoFullName}`));
        if (!pagination.hasNextPage) break;
      }
      return repos;
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
    const unique = [...new Set(await source.fetch())];
    const merged = [...new Set([...unique, ...previous])].sort();
    await writeJson(source.path, merged);
    console.log(
      `[INFO] ${name}: wrote ${merged.length} sources (fetched=${unique.length}, added=${unique.filter((s) => !previous.includes(s)).length})`,
    );
  });

await program.parseAsync();
