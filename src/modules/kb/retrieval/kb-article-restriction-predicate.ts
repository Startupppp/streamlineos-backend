import { inArray, sql, type SQL } from "drizzle-orm";
import { kbPages, kbPageRestrictions } from "../../../db/schema";

export function buildArticleRestrictionPredicate(
  orgId: string,
  principal: { userId: string; membershipId: number | null; roleSlugs: string[] },
): SQL {
  const kpr = kbPageRestrictions;
  const membershipMatch =
    principal.membershipId !== null
      ? sql`${kpr.membershipId} = ${principal.membershipId} OR `
      : sql``;
  return sql`(
    NOT EXISTS (
      SELECT 1 FROM ${kpr}
      WHERE ${kpr.pageId} = ${kbPages.id}
        AND ${kpr.orgId} = ${orgId}
        AND ${kpr.level} = 'view'
    )
    OR EXISTS (
      SELECT 1 FROM ${kpr}
      WHERE ${kpr.pageId} = ${kbPages.id}
        AND ${kpr.orgId} = ${orgId}
        AND ${kpr.level} = 'view'
        AND (${membershipMatch}${
          principal.roleSlugs.length > 0
            ? inArray(kpr.role, principal.roleSlugs)
            : sql`false`
        })
    )
  )`;
}
