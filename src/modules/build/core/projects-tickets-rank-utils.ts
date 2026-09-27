import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { tickets } from "../../../db/schema";
import type { CacheService } from "../../../common/cache/cache.service";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { AccessService } from "../../access/access.service";
import type { RankTicketInput } from "./dto/projects.schemas";
import { authorizeTicketMutation, lockProjectTicketMutation, readMutationTickets } from "./build-ticket-mutation-policy";
import { emitBatchStatusChanges, validateBatchTransition } from "./build-ticket-batch-workflow";

export async function rebalanceProjectRanks(db: Db, orgId: string, projectId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await lockProjectTicketMutation(tx, orgId, projectId);
    await tx.execute(sql`
      WITH ordered AS (
        SELECT id, row_number() OVER (ORDER BY rank ASC, id ASC) * 1000 AS new_rank
        FROM build.tickets WHERE org_id = ${orgId} AND project_id = ${projectId} AND deleted_at IS NULL
      ) UPDATE build.tickets t SET rank = ordered.new_rank
        FROM ordered WHERE t.id = ordered.id AND t.org_id = ${orgId} AND t.project_id = ${projectId}
    `);
  });
}

export async function rankTicket(db: Db, cache: CacheService, access: AccessService, actor: CurrentUserContext, projectId: number, ticketId: number, body: RankTicketInput) {
  if (body.beforeTicketId === ticketId || body.afterTicketId === ticketId ||
      (body.beforeTicketId != null && body.beforeTicketId === body.afterTicketId))
    throw new BadRequestException("Rank neighbours must be distinct from the target and each other");
  const result = await db.transaction(async (tx) => {
    const policy = await authorizeTicketMutation(tx, access, actor, projectId);
    await lockProjectTicketMutation(tx, actor.orgId, projectId);
    const ids = [ticketId, ...[body.beforeTicketId, body.afterTicketId].filter((id): id is number => id != null)];
    let rows = await readMutationTickets(tx, actor, projectId, ids, policy);
    const initialBefore = rows.find((row) => row.id === body.beforeTicketId);
    const initialAfter = rows.find((row) => row.id === body.afterTicketId);
    if ((initialBefore && initialAfter && initialBefore.rank === initialAfter.rank) ||
        rows.some((row) => (row.rank.split(".")[1]?.length ?? 0) > 20)) {
      await rebalanceProjectRanks(tx, actor.orgId, projectId);
      rows = await readMutationTickets(tx, actor, projectId, ids, policy);
    }
    const target = rows.find((row) => row.id === ticketId);
    if (!target) throw new NotFoundException("Ticket not found");
    const before = rows.find((row) => row.id === body.beforeTicketId);
    const after = rows.find((row) => row.id === body.afterTicketId);
    const status = body.status ?? target.status;
    if ([before, after].some((row) => row && row.status !== status))
      throw new BadRequestException("Rank neighbours must be in the destination column");
    const lower = before ? sql`${before.rank}::numeric` : undefined;
    const upper = after ? sql`${after.rank}::numeric` : undefined;
    const [gap] = await tx.select({ id: tickets.id }).from(tickets).where(and(
      eq(tickets.orgId, actor.orgId), eq(tickets.projectId, projectId), eq(tickets.status, status),
      notInArray(tickets.id, ids), isNull(tickets.deletedAt),
      before ? sql`(${tickets.rank} > ${before.rank}::numeric OR (${tickets.rank} = ${before.rank}::numeric AND ${tickets.id} > ${before.id}))` : undefined,
      after ? sql`(${tickets.rank} < ${after.rank}::numeric OR (${tickets.rank} = ${after.rank}::numeric AND ${tickets.id} < ${after.id}))` : undefined,
    )).limit(1);
    if (gap) throw new ConflictException("Board order changed; refresh and retry");
    const rank = lower && upper ? sql`(${lower} + ${upper}) / 2`
      : lower ? sql`${lower} + 1000` : upper ? sql`${upper} - 1000` : sql`1000`;
    const [positionRow] = await tx.execute(sql`
      SELECT (${rank})::text AS rank,
        ${lower ? sql`(${rank}) > ${lower}` : sql`true`} AND
        ${upper ? sql`(${rank}) < ${upper}` : sql`true`} AS valid
    `);
    if (!positionRow?.valid) throw new ConflictException("Rank gap exhausted or reversed; refresh board order");
    const rankValue = String(positionRow?.rank ?? "");
    if (body.status !== undefined) await validateBatchTransition(tx, actor, projectId, [target], status, policy.role);
    const now = new Date();
    const [updated] = await tx.update(tickets).set({ rank: rankValue, status, updatedAt: now })
      .where(and(eq(tickets.orgId, actor.orgId), eq(tickets.projectId, projectId), eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
      .returning({ id: tickets.id, rank: tickets.rank, status: tickets.status });
    if (!updated) throw new NotFoundException("Ticket not found");
    if (body.status !== undefined) await emitBatchStatusChanges(tx, actor, projectId, [target], status, now);
    return updated;
  });
  await cache.invalidateNamespace(`build:analytics:${actor.orgId}`)
    .catch(logSideEffectFailure("analytics cache eviction", { orgId: actor.orgId, projectId }));
  return result;
}
