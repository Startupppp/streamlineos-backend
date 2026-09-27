import { and, eq } from "drizzle-orm";
import { projectStatuses } from "../../../../db/schema";
import type { Db, TenantTx } from "../../../../db/drizzle.types";

const CANONICAL_TICKET_STATUSES = new Set(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]);

export async function resolveValidTicketStatuses(
  db: Db | TenantTx,
  projectId: number,
  orgId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ name: projectStatuses.name })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.orgId, orgId)));
  const result = new Set(CANONICAL_TICKET_STATUSES);
  for (const row of rows) result.add(row.name);
  return result;
}
