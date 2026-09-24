import { NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { deals, projects } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";

type DbOrTx = Db | TenantTx;

/**
 * Validates a client-supplied `dealId` before it is trusted as a foreign key.
 *
 * `deals.id` alone is not tenant-scoped, so an unchecked id would let an
 * invoice in one organization point at another organization's deal — the
 * same reasoning `assertTimesheetEntriesLinkable` applies to a linked
 * timesheet entry (BE-90/91: a cross-tenant miss is 404, never a raw insert
 * that the `NOT VALID` foreign key silently accepts until the next validate).
 */
export async function assertDealBelongsToOrg(
  db: DbOrTx,
  orgId: string,
  dealId: number,
): Promise<number> {
  const [row] = await db
    .select({ id: deals.id })
    .from(deals)
    .where(and(eq(deals.orgId, orgId), eq(deals.id, dealId), isNull(deals.deletedAt)));
  if (!row) throw new NotFoundException("Deal not found");
  return row.id;
}

/**
 * The deal an invoice should default to when none is given explicitly: the
 * single project's own `deal_id`, the same link `projects.dealId` already
 * carries. Returns null rather than guessing when the billed time spans more
 * than one project, or the resolved project carries no deal.
 */
export async function resolveProjectDealId(
  db: DbOrTx,
  orgId: string,
  projectIds: readonly (number | null)[],
): Promise<number | null> {
  const distinct = [...new Set(projectIds)];
  if (distinct.length !== 1) return null;
  const projectId = distinct[0];
  if (projectId === null || projectId === undefined) return null;

  const [row] = await db
    .select({ dealId: projects.dealId })
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId), isNull(projects.deletedAt)));
  return row?.dealId ?? null;
}
