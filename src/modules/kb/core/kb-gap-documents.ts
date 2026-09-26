import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { supportArticlePredicate } from "../help-centre/kb-article-page-scope";

export function proposedDocumentScopePredicate(): SQL {
  return sql`(${supportArticlePredicate()} AND ${isNull(kbPages.archivedAt)})`;
}

export async function resolveProposedDocumentTitles(
  db: Db,
  orgId: string,
  documentIds: number[],
): Promise<Map<number, string>> {
  if (documentIds.length === 0) return new Map();

  const rows = await db
    .select({ id: kbPages.id, title: kbPages.title })
    .from(kbPages)
    .where(
      and(
        eq(kbPages.orgId, orgId),
        inArray(kbPages.id, documentIds),
        proposedDocumentScopePredicate(),
      ),
    );

  const result = new Map<number, string>();
  for (const row of rows) {
    if (row.title !== null) result.set(row.id, row.title);
  }
  return result;
}
