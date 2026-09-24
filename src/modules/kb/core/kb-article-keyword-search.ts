import { inArray, sql, type SQL } from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";

/**
 * One keyword plan for every kb_pages read, help-centre and wiki alike.
 * `GET /kb/articles?search=` used a leading-wildcard ilike on title+excerpt while
 * the search endpoint went through the SECURITY DEFINER id function over the GIN
 * index, so the two disagreed on the same term and only one of them could use it.
 */
export function articleTsquery(term: string): SQL {
  return sql`websearch_to_tsquery('english', ${term})`;
}

export function articleKeywordFallback(term: string, tsquery: SQL): SQL {
  const like = `%${term}%`;
  return sql`(fts @@ ${tsquery} or (numnode(${tsquery}) = 0 and (${kbPages.title} ilike ${like} or ${kbPages.excerpt} ilike ${like} or ${kbPages.contentText} ilike ${like})))`;
}

export async function resolveArticleKeywordSql(
  db: Db,
  term: string,
  tsquery: SQL,
  cap: number,
): Promise<SQL> {
  const rows = await db.execute(sql`SELECT app.search_kb_page_ids(${term}, ${cap + 1}) AS id`);
  if (rows.length === 0 || rows.length > cap) return articleKeywordFallback(term, tsquery);
  return inArray(
    kbPages.id,
    rows.map((row) => Number(row["id"])),
  );
}
