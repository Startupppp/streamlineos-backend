import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { supportArticlePredicate } from "../help-centre/kb-article-page-scope";
import { buildVisiblePageScope } from "./authorization/knowledge-page-scope";
import type { KbActorStanding } from "./authorization/knowledge-authorization.types";

const HELPDESK_KB_SUGGEST_CAP = 20;

export async function suggestHelpdeskDocuments(
  db: Db,
  standing: KbActorStanding,
  query: string,
): Promise<{ results: Array<{ id: number; title: string | null; slug: string; excerpt: string | null; source: string }> }> {
  const like = `%${query}%`;
  const scope = buildVisiblePageScope(standing, "view");

  const inScope = and(
    scope.predicate,
    eq(kbPages.status, "published"),
    supportArticlePredicate(),
    isNotNull(kbPages.slug),
  );

  const fallback = and(
    inScope,
    or(sql`${kbPages.title} ILIKE ${like}`, sql`${kbPages.excerpt} ILIKE ${like}`),
  );

  const rows = await db.execute(
    sql`SELECT app.search_kb_page_ids(${query}, ${HELPDESK_KB_SUGGEST_CAP + 1}) AS id`,
  );

  const articleWhere =
    rows.length === 0
      ? sql`false`
      : rows.length > HELPDESK_KB_SUGGEST_CAP
        ? fallback
        : and(inScope, inArray(kbPages.id, rows.map((r) => Number(r["id"]))));

  const articles = await db
    .select({
      id: kbPages.id,
      title: kbPages.title,
      slug: kbPages.slug,
      excerpt: kbPages.excerpt,
      source: sql<string>`'article'`,
    })
    .from(kbPages)
    .where(articleWhere)
    .orderBy(desc(kbPages.updatedAt))
    .limit(5);

  const slugged = articles.flatMap((r) =>
    r.slug === null ? [] : [{ ...r, slug: r.slug }],
  );
  return { results: slugged };
}
