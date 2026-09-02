import { Logger, NotFoundException } from "@nestjs/common";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import {
  projectMembers,
  tickets,
} from "../../../db/schema";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

const rankLogger = new Logger("TicketRank");
import type { Db } from "../../../db/drizzle.types";
import type { CacheService } from "../../../common/cache/cache.service";
import type { RankTicketInput } from "./dto/projects.schemas";
import { assertTransitionAllowed } from "./projects-tickets-workflow-utils";

export const REBALANCE_SCALE_THRESHOLD = 20;

export function decimalScale(n: number): number {
  const s = n.toString();
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

export async function rebalanceProjectRanks(
  db: Db,
  orgId: string,
  projectId: number,
): Promise<void> {
  const MAX_TICKETS = 10_000;

  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          eq(tickets.orgId, orgId),
          eq(tickets.projectId, projectId),
          isNull(tickets.deletedAt),
        ),
      )
      .orderBy(asc(tickets.rank), desc(tickets.createdAt), asc(tickets.id))
      .limit(MAX_TICKETS);

    if (rows.length === 0) return;

    const ids = rows.map((r) => r.id);
    const cases = rows.map(
      (r, i) => sql`WHEN ${r.id} THEN ${String((i + 1) * 1000)}`,
    );
    await tx
      .update(tickets)
      .set({
        rank: sql`(CASE ${tickets.id} ${sql.join(cases, sql` `)} END)`,
      })
      .where(
        and(
          eq(tickets.orgId, orgId),
          eq(tickets.projectId, projectId),
          inArray(tickets.id, ids),
        ),
      );
  });
}

export async function rankTicket(
  db: Db,
  cache: CacheService,
  orgId: string,
  projectId: number,
  ticketId: number,
  body: RankTicketInput,
  context: { userId: string; isOrgOwner: boolean; membershipId?: number },
) {
  const [targetRow] = await db
    .select({ id: tickets.id, status: tickets.status, rank: tickets.rank })
    .from(tickets)
    .where(
      and(
        eq(tickets.id, ticketId),
        eq(tickets.orgId, orgId),
        eq(tickets.projectId, projectId),
        isNull(tickets.deletedAt),
      ),
    )
    .limit(1);
  if (!targetRow) throw new NotFoundException("Ticket not found");

  let beforeRank: number | null = null;
  let afterRank: number | null = null;

  if (body.beforeTicketId != null) {
    const [row] = await db
      .select({ rank: tickets.rank })
      .from(tickets)
      .where(
        and(
          eq(tickets.id, body.beforeTicketId),
          eq(tickets.orgId, orgId),
          eq(tickets.projectId, projectId),
          isNull(tickets.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Neighbour ticket not found");
    beforeRank = Number(row.rank);
  }

  if (body.afterTicketId != null) {
    const [row] = await db
      .select({ rank: tickets.rank })
      .from(tickets)
      .where(
        and(
          eq(tickets.id, body.afterTicketId),
          eq(tickets.orgId, orgId),
          eq(tickets.projectId, projectId),
          isNull(tickets.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Neighbour ticket not found");
    afterRank = Number(row.rank);
  }

  let newRank: number;
  if (beforeRank !== null && afterRank !== null)
    newRank = (beforeRank + afterRank) / 2;
  else if (afterRank !== null) newRank = afterRank - 1000;
  else if (beforeRank !== null) newRank = beforeRank + 1000;
  else newRank = 1000;

  const newStatus = body.status ?? targetRow.status;
  const statusChanging =
    body.status !== undefined && body.status !== targetRow.status;

  if (statusChanging) {
    const [memberRow] = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.orgId, orgId),
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.membershipId, context.membershipId ?? -1),
        ),
      )
      .limit(1);
    const userProjectRole = memberRow?.role ?? null;

    await assertTransitionAllowed(
      db,
      orgId,
      projectId,
      targetRow.status,
      newStatus,
      {
        userId: context.userId,
        userProjectRole,
        isOrgOwner: context.isOrgOwner,
        ticketId,
      },
    );
  }

  const [updated] = await db
    .update(tickets)
    .set({ rank: String(newRank), status: newStatus, updatedAt: new Date() })
    .where(
      and(
        eq(tickets.id, ticketId),
        eq(tickets.orgId, orgId),
        eq(tickets.projectId, projectId),
      ),
    )
    .returning({
      id: tickets.id,
      rank: tickets.rank,
      status: tickets.status,
    });

  if (!updated) throw new NotFoundException("Ticket not found");

  if (statusChanging) {
    void cache
      .del(`projects:analytics:${orgId}:${projectId}`)
      .catch(logSideEffectFailure("analytics cache eviction", { orgId, projectId }));
  }

  const scale = decimalScale(newRank);
  if (scale > REBALANCE_SCALE_THRESHOLD)
    registerAfterCommit(() =>
      runInNewTenantTransaction(db, orgId, (tx) =>
        rebalanceProjectRanks(tx, orgId, projectId),
      ).catch((error: unknown) => {
        rankLogger.error(
          `rank rebalance failed for project ${projectId} in org ${orgId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }),
    );

  return { id: updated.id, rank: updated.rank, status: updated.status };
}
