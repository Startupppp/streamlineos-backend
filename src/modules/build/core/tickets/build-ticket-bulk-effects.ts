import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.types";
import { organizationMembers, tickets } from "../../../../db/schema";

export async function readBulkTicketMeta(
  tx: Db,
  orgId: string,
  ticketIds: readonly number[],
): Promise<Map<number, { title: string; type: string; reporterId: string | null }>> {
  const unique = [...new Set(ticketIds)];
  const meta = new Map<number, { title: string; type: string; reporterId: string | null }>();
  if (unique.length === 0) return meta;
  const rows = await tx
    .select({
      id: tickets.id,
      title: tickets.title,
      type: tickets.type,
      reporterId: tickets.reporterId,
    })
    .from(tickets)
    .where(
      and(
        eq(tickets.orgId, orgId),
        inArray(tickets.id, unique),
        isNull(tickets.deletedAt),
      ),
    )
    .limit(unique.length);
  for (const row of rows)
    meta.set(row.id, { title: row.title, type: row.type, reporterId: row.reporterId });
  return meta;
}

export async function readMembershipUserIds(
  tx: Db,
  orgId: string,
  membershipIds: readonly number[],
): Promise<Map<number, string>> {
  const unique = [...new Set(membershipIds)];
  const byMembership = new Map<number, string>();
  if (unique.length === 0) return byMembership;
  const rows = await tx
    .select({ id: organizationMembers.id, userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.id, unique)),
    )
    .limit(unique.length);
  for (const row of rows) byMembership.set(row.id, row.userId);
  return byMembership;
}
