import { inArray, sql, type SQL } from "drizzle-orm";
import { kbArticles } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";

/**
 * One keyword plan for every kb_articles read. `GET /kb/articles?search=` used a
 * leading-wildcard ilike on title+excerpt while the search endpoint went through
 * app.search_kb_article_ids over idx_kb_articles_fts, so the two disagreed on the
 * same term and only one of them could use the GIN index.
 */
export function articleTsquery(term: string): SQL {
  return sql`websearch_to_tsquery('english', ${term})`;
}

export function articleKeywordFallback(term: string, tsquery: SQL): SQL {
  const like = `%${term}%`;
  return sql`(fts @@ ${tsquery} or (numnode(${tsquery}) = 0 and (${kbArticles.title} ilike ${like} or ${kbArticles.excerpt} ilike ${like} or ${kbArticles.contentText} ilike ${like})))`;
}

export async function resolveArticleKeywordSql(
  db: Db,
  term: string,
  tsquery: SQL,
  cap: number,
): Promise<SQL> {
  const rows = await db.execute(sql`SELECT app.search_kb_article_ids(${term}, ${cap + 1}) AS id`);
  if (rows.length === 0 || rows.length > cap) return articleKeywordFallback(term, tsquery);
  return inArray(
    kbArticles.id,
    rows.map((row) => Number(row["id"])),
  );
}
