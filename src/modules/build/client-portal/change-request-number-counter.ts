import { and, eq, sql } from "drizzle-orm";
import { changeRequests } from "../../../db/schema";
import type { TenantTx } from "../../../db/drizzle.types";

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
