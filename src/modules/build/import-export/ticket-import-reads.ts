import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { projectStatuses, tickets } from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";

const TITLE_KEY_SQL = sql`regexp_replace(lower(btrim(${tickets.title})), '\\s+', ' ', 'g')`;

export async function readProjectStatusNames(
  db: DbOrTx,
  orgId: string,
  projectId: number,
): Promise<string[]> {
  const rows = await db
    .select({ name: projectStatuses.name })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.orgId, orgId), eq(projectStatuses.projectId, projectId)))
    .orderBy(projectStatuses.order, projectStatuses.id);
  return rows.map((row) => row.name);
}

export async function readConflictingTitleKeys(
  db: DbOrTx,
  orgId: string,
  projectId: number,
  keys: readonly string[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await db
    .select({ key: sql<string>`${TITLE_KEY_SQL}` })
    .from(tickets)
    .where(
      and(
        eq(tickets.orgId, orgId),
        eq(tickets.projectId, projectId),
        isNull(tickets.deletedAt),
        inArray(TITLE_KEY_SQL, [...keys]),
      ),
    );
  return rows.map((row) => row.key);
}

export async function nextTicketNumber(
  tx: DbOrTx,
  orgId: string,
  projectId: number,
): Promise<number> {
  const [row] = await tx
    .select({ value: sql<number | null>`max(${tickets.ticketNumber})` })
    .from(tickets)
    .where(and(eq(tickets.orgId, orgId), eq(tickets.projectId, projectId)));
  return Number(row?.value ?? 0) + 1;
}
