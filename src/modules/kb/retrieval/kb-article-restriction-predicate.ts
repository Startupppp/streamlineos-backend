import { inArray, sql, type SQL } from "drizzle-orm";
import { kbArticles, kbArticleRestrictions } from "../../../db/schema";

export function buildArticleRestrictionPredicate(
  orgId: string,
  principal: { userId: string; membershipId: number | null; roleSlugs: string[] },
): SQL {
  const kar = kbArticleRestrictions;
  const membershipMatch =
    principal.membershipId !== null
      ? sql`${kar.membershipId} = ${principal.membershipId} OR `
      : sql``;
  return sql`(
    NOT EXISTS (
      SELECT 1 FROM ${kar}
      WHERE ${kar.articleId} = ${kbArticles.id}
        AND ${kar.orgId} = ${orgId}
        AND ${kar.level} = 'view'
    )
    OR EXISTS (
      SELECT 1 FROM ${kar}
      WHERE ${kar.articleId} = ${kbArticles.id}
        AND ${kar.orgId} = ${orgId}
        AND ${kar.level} = 'view'
        AND (${membershipMatch}${
          principal.roleSlugs.length > 0
            ? inArray(kar.role, principal.roleSlugs)
            : sql`false`
        })
    )
  )`;
}
