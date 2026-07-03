import { and, eq } from "drizzle-orm";
import { projectStatuses } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";

export const CANONICAL_TICKET_STATUSES = new Set(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]);

export async function resolveValidTicketStatuses(
  db: Db,
  projectId: number,
  orgId: string,
  statuses: string[],
): Promise<Set<string>> {
  const nonCanonical = statuses.filter((s) => !CANONICAL_TICKET_STATUSES.has(s));
  if (nonCanonical.length === 0) return CANONICAL_TICKET_STATUSES;
  const rows = await db
    .select({ name: projectStatuses.name })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.orgId, orgId)));
  const result = new Set(CANONICAL_TICKET_STATUSES);
  for (const row of rows) result.add(row.name);
  return result;
}
