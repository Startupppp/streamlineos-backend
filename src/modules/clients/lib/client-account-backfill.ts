import { Logger } from "@nestjs/common";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Redis } from "@upstash/redis";
import { clientAccounts, users } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";

/**
 * Opening the accounts nobody opened, and sharing out the ones nobody owns.
 *
 * This is the half of `ClientAccountsService` that runs BESIDE a request rather
 * than for it. `tryBackfill` is fired off the client list with `void`, behind a
 * sixty-second Redis lock, and every failure inside it is caught and logged as a
 * warning — the list still renders. Everything else in that service throws at
 * the caller, and a reader who could not see which was which would have to guess
 * whether a thrown error reaches the browser.
 *
 * Two jobs, one lock, because they compose: converting a lead opens an account
 * with no CRM owner, and the round-robin below is what gives it one. Running the
 * assignment without the conversion would hand out yesterday's accounts.
 *
 * `getCrmAssignmentStats` and `runCrmAssignments` come along because they are
 * the endpoints that report and force this same job, and the counting query is
 * the assignment query with the projection changed.
 */

export interface ClientAccountBackfillDeps {
  readonly db: Db;
  readonly redis: Redis | null;
  readonly access: AccessService;
  readonly logger: Logger;
}

export async function getCrmAssignmentStats(deps: ClientAccountBackfillDeps, orgId: string) {
  const csMemberIds = (await deps.access.membersWithPermission(orgId, "support:tickets:manage", { limit: 500 })).map((m) => m.userId);

  if (csMemberIds.length === 0) {
    return { members: [], unassignedCount: 0 };
  }

  const csMembers = await deps.db
    .select({ userId: users.id, name: users.name, image: users.image })
    .from(users)
    .where(inArray(users.id, csMemberIds));

  const memberIds = csMembers.map((m) => m.userId);

  const [countRows, [unassignedResult]] = await Promise.all([
    deps.db
      .select({
        userId: clientAccounts.assignedCrmId,
        totalCount: count(),
        activeCount: sql<number>`count(*) FILTER (WHERE ${clientAccounts.status} != 'INVESTED')`,
      })
      .from(clientAccounts)
      .where(and(eq(clientAccounts.orgId, orgId), inArray(clientAccounts.assignedCrmId, memberIds)))
      .groupBy(clientAccounts.assignedCrmId),
    deps.db
      .select({ count: count() })
      .from(clientAccounts)
      .where(and(eq(clientAccounts.orgId, orgId), isNull(clientAccounts.assignedCrmId))),
  ]);

  const countMap = new Map(countRows.map((r) => [r.userId, r]));

  return {
    members: csMembers.map((m) => ({
      userId: m.userId,
      name: m.name,
      image: m.image,
      activeCount: Number(countMap.get(m.userId)?.activeCount ?? 0),
      totalCount: countMap.get(m.userId)?.totalCount ?? 0,
    })),
    unassignedCount: unassignedResult?.count ?? 0,
  };
}

export async function runCrmAssignments(deps: ClientAccountBackfillDeps, orgId: string) {
  await backfillCrmAssignments(deps, orgId);
  return getCrmAssignmentStats(deps, orgId);
}

export async function tryBackfill(
  deps: ClientAccountBackfillDeps,
  orgId: string,
  userId: string,
): Promise<void> {
  const lockKey = `clients:backfill:${orgId}`;
  if (deps.redis) {
    try {
      const acquired = await deps.redis.set(lockKey, "1", { ex: 60, nx: true });
      if (!acquired) return;
    } catch (err) {
      deps.logger.warn(`Redis lock acquire failed for client backfill ${orgId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    await backfillConvertedLeadsToClientAccounts(deps, orgId, userId);
    await backfillCrmAssignments(deps, orgId);
  } catch (err) {
    deps.logger.warn(`Client account backfill failed for org ${orgId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Opens a client account for every lead that has converted and has none.
 *
 * Reads Party, not `leads`. This was raw SQL against the legacy table, which
 * neither the reader ratchet nor the lint rule could see -- both match Drizzle
 * symbol imports, and a string never imports anything. So it survived every
 * migrate batch, and ticket 08's drop would have taken it out at runtime with
 * nothing having warned.
 *
 * The read is not merely relocated. `leads` is a mirror, and a merge leaves the
 * losing row alive holding the survivor's values while marking only the Party
 * deleted -- so `FROM leads WHERE deleted_at IS NULL` counted one converted
 * customer twice and opened two accounts for them. Joining through
 * `lead_party_map` and filtering on the Party's own `deleted_at` counts the
 * customer.
 *
 * The map is keyed by legacy id and its `party_id` side is deliberately not
 * unique -- after a merge several ids answer to one Party. That is correct
 * here rather than a hazard: `client_accounts.lead_id` is the legacy id, the
 * anti-join is on that id, so each surviving id still gets exactly one account.
 */
async function backfillConvertedLeadsToClientAccounts(
  deps: ClientAccountBackfillDeps,
  orgId: string,
  fallbackSalesRepId: string,
): Promise<void> {
  await deps.db.execute(sql`
    INSERT INTO client_accounts (
      org_id, lead_id, sales_rep_id,
      client_name, client_email, client_phone, client_whatsapp,
      estimated_investment, status, converted_at, created_at, updated_at
    )
    SELECT
      m.organization_id,
      m.lead_id,
      COALESCE(p.owner_user_id, ${fallbackSalesRepId}),
      p.name,
      p.email,
      p.phone,
      p.whatsapp_phone,
      COALESCE(p.expected_value, p.stated_budget)::numeric(15,2),
      'ACCOUNT_OPENING'::text,
      COALESCE(p.converted_at, NOW()),
      NOW(),
      NOW()
    FROM lead_party_map m
    JOIN business_parties p
      ON p.party_id = m.party_id
     AND p.organization_id = m.organization_id
    WHERE m.organization_id = ${orgId}
      AND p.lifecycle_stage = 'CONVERTED'
      AND p.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM client_accounts ca
        WHERE ca.org_id = m.organization_id AND ca.lead_id = m.lead_id
      )
  `);
}

async function backfillCrmAssignments(
  deps: ClientAccountBackfillDeps,
  orgId: string,
): Promise<void> {
  const csMembers = await deps.access.membersWithPermission(orgId, "support:tickets:manage", { limit: 500 });

  if (csMembers.length === 0) return;

  const memberIds = csMembers.map((m) => m.userId);

  const [countRows, unassigned] = await Promise.all([
    deps.db
      .select({ userId: clientAccounts.assignedCrmId, activeCount: count() })
      .from(clientAccounts)
      .where(
        and(
          eq(clientAccounts.orgId, orgId),
          inArray(clientAccounts.assignedCrmId, memberIds),
          sql`${clientAccounts.status} != 'INVESTED'`,
        ),
      )
      .groupBy(clientAccounts.assignedCrmId),
    deps.db
      .select({ id: clientAccounts.id })
      .from(clientAccounts)
      .where(and(eq(clientAccounts.orgId, orgId), isNull(clientAccounts.assignedCrmId)))
      .orderBy(desc(clientAccounts.createdAt)),
  ]);

  if (unassigned.length === 0) return;

  const counts: Record<string, number> = Object.fromEntries(memberIds.map((id) => [id, 0]));
  for (const row of countRows) {
    if (row.userId) counts[row.userId] = row.activeCount;
  }

  const assignments: Record<string, number[]> = {};
  for (const account of unassigned) {
    let minCount = Infinity;
    let assignee: string | null = null;
    for (const id of memberIds) {
      if ((counts[id] ?? 0) < minCount) {
        minCount = counts[id] ?? 0;
        assignee = id;
      }
    }
    if (assignee) {
      (assignments[assignee] ??= []).push(account.id);
      counts[assignee] = (counts[assignee] ?? 0) + 1;
    }
  }

  const now = new Date();
  await Promise.all(
    Object.entries(assignments).map(([assigneeId, ids]) =>
      deps.db
        .update(clientAccounts)
        .set({ assignedCrmId: assigneeId, updatedAt: now })
        .where(and(eq(clientAccounts.orgId, orgId), inArray(clientAccounts.id, ids))),
    ),
  );
}
