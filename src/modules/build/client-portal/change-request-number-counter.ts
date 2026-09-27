import { and, eq, sql } from "drizzle-orm";
import { changeRequests } from "../../../db/schema";
import type { TenantTx } from "../../../db/drizzle.types";

/**
 * Allocate the next change-request number for a project.
 *
 * Must be called inside an open transaction. Takes a project-scoped advisory
 * lock so two concurrent callers cannot read the same MAX and produce the same
 * number. The lock is released when the enclosing transaction commits or
 * rolls back.
 */
export async function nextChangeRequestNumber(
  tx: TenantTx,
  orgId: string,
  projectId: number,
): Promise<number> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
  const [maxRow] = await tx
    .select({ maxNum: sql<number>`COALESCE(MAX(${changeRequests.crNumber}), 0)` })
    .from(changeRequests)
    .where(and(eq(changeRequests.projectId, projectId), eq(changeRequests.orgId, orgId)));
  return (maxRow?.maxNum ?? 0) + 1;
}
