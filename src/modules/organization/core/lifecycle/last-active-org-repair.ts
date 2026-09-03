import { and, eq, inArray } from "drizzle-orm";
import { accountOrganizationIndex, users } from "../../../../db/schema";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";
import { bulkUpdateFromValues } from "../../../../common/db/bulk-update";

/**
 * One statement per chunk of member ids for the uniform ARCHIVED stamp. The
 * per-member `last_active_org_id` differs per row, so that half goes through
 * `bulkUpdateFromValues`, which chunks under its own BULK_UPDATE_CHUNK.
 */
const ARCHIVE_INDEX_CHUNK = 500;

/**
 * Archiving or purging an organisation has to move every member off it. Both
 * callers previously issued two UPDATEs per member — 1,000 statements for a
 * 500-member organisation, inside the transaction that also runs the purge.
 *
 * `users` carries no `org_id`; the tenant correlation on that table is
 * `last_active_org_id` itself, which is also the compare-and-set the per-row
 * form relied on to avoid stamping a member who had already moved on. It is
 * passed as the helper's org column so the batched statement keeps it.
 */
export async function repairLastActiveOrgIds(
  db: DbOrTx,
  orgId: string,
  replacements: Map<string, string | null>,
): Promise<void> {
  if (replacements.size === 0) return;

  await bulkUpdateFromValues(db, {
    table: users,
    orgId,
    orgColumn: "last_active_org_id",
    key: { column: "id", type: "text" },
    columns: [{ column: "last_active_org_id", type: "text" }],
    rows: [...replacements].map(([memberUserId, nextOrgId]) => ({
      key: memberUserId,
      values: [nextOrgId],
    })),
  });

  const memberUserIds = [...replacements.keys()];
  for (let i = 0; i < memberUserIds.length; i += ARCHIVE_INDEX_CHUNK)
    await db
      .update(accountOrganizationIndex)
      .set({ organizationStatus: "ARCHIVED" })
      .where(
        and(
          eq(accountOrganizationIndex.orgId, orgId),
          inArray(accountOrganizationIndex.userId, memberUserIds.slice(i, i + ARCHIVE_INDEX_CHUNK)),
        ),
      );
}
