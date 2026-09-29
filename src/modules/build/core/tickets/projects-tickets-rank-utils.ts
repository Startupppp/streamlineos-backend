import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { TicketVersionConflictException } from "./ticket-version-conflict.exception";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.types";
import { tickets } from "../../../../db/schema";
import type { CacheService } from "../../../../common/cache/cache.service";
import { logSideEffectFailure } from "../../../../common/logger/side-effect";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { AccessService } from "../../../access/access.service";
import type { RankTicketInput } from "../dto/projects.schemas";
import {
  authorizeTicketMutation,
  lockProjectTicketMutation,
  readMutationTickets,
} from "../lib/build-ticket-mutation-policy";
import {
  emitBatchStatusChanges,
  validateBatchTransition,
} from "./build-ticket-batch-workflow";
import type { TicketEventPayload } from "../automation/build-automation-runner.service";
import type { DispatchEventInput } from "../../../notifications/notification.types";
import { withSavepoint } from "../../../data-quality/savepoint";
import { logger } from "../../../../common/logger/logger.service";
import { buildTicketBoardHref } from "../lib/build-app-paths";

export interface RankTicketEffectDeps {
  readonly webhooksDispatch: {
    enqueue(
      tx: unknown,
      orgId: string,
      projectId: number,
      event: string,
      payload: Record<string, unknown>,
    ): Promise<void>;
  };
  readonly automationRunner: {
    runForTicketEvent(
      orgId: string,
      projectId: number,
      event: string,
      payload: TicketEventPayload,
    ): void;
  };
  readonly activity?: {
    logTicketFieldChanges(
      orgId: string,
      ticketId: number,
      userId: string,
      before: {
        title: string;
        status: string;
        priority: string;
        assigneeId: string | null;
        dueDate: string | null;
        points: number | null;
        type: string;
        cycleId: number | null;
      },
      changes: { status?: string },
    ): Promise<void>;
  };
  readonly dispatch?: {
    emit(input: DispatchEventInput): Promise<unknown>;
  };
}

export async function rebalanceProjectRanks(
  db: Db,
  orgId: string,
  projectId: number,
): Promise<void> {
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

export async function rankTicket(
  db: Db,
  cache: CacheService,
  access: AccessService,
  actor: CurrentUserContext,
  projectId: number,
  ticketId: number,
  body: RankTicketInput,
  effectDeps?: RankTicketEffectDeps,
) {
  if (
    body.beforeTicketId === ticketId ||
    body.afterTicketId === ticketId ||
    (body.beforeTicketId != null && body.beforeTicketId === body.afterTicketId)
  )
    throw new BadRequestException(
      "Rank neighbours must be distinct from the target and each other",
    );
  let previousStatus: string | undefined;
  let capturedTarget:
    | { priority: string | null; dueDate: string | null; points: number | null; cycleId: number | null }
    | undefined;
  let capturedReviewData: { reporterId: string | null; title: string } | undefined;
  const result = await db.transaction(async (tx) => {
    const policy = await authorizeTicketMutation(tx, access, actor, projectId);
    await lockProjectTicketMutation(tx, actor.orgId, projectId);
    const ids = [
      ticketId,
      ...[body.beforeTicketId, body.afterTicketId].filter(
        (id): id is number => id != null,
      ),
    ];
    let rows = await readMutationTickets(tx, actor, projectId, ids, policy);
    const initialBefore = rows.find((row) => row.id === body.beforeTicketId);
    const initialAfter = rows.find((row) => row.id === body.afterTicketId);
    if (
      (initialBefore &&
        initialAfter &&
        initialBefore.rank === initialAfter.rank) ||
      rows.some((row) => (row.rank.split(".")[1]?.length ?? 0) > 20)
    ) {
      await rebalanceProjectRanks(tx, actor.orgId, projectId);
      rows = await readMutationTickets(tx, actor, projectId, ids, policy);
    }
    const target = rows.find((row) => row.id === ticketId);
    if (!target) throw new NotFoundException("Ticket not found");
    if (body.version !== undefined && body.version !== target.version)
      throw new TicketVersionConflictException(target.version);
    const before = rows.find((row) => row.id === body.beforeTicketId);
    const after = rows.find((row) => row.id === body.afterTicketId);
    const status = body.status ?? target.status;
    if ([before, after].some((row) => row && row.status !== status))
      throw new BadRequestException(
        "Rank neighbours must be in the destination column",
      );
    const lower = before ? sql`${before.rank}::numeric` : undefined;
    const upper = after ? sql`${after.rank}::numeric` : undefined;
    const [gap] = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          eq(tickets.orgId, actor.orgId),
          eq(tickets.projectId, projectId),
          eq(tickets.status, status),
          notInArray(tickets.id, ids),
          isNull(tickets.deletedAt),
          before
            ? sql`(${tickets.rank} > ${before.rank}::numeric OR (${tickets.rank} = ${before.rank}::numeric AND ${tickets.id} > ${before.id}))`
            : undefined,
          after
            ? sql`(${tickets.rank} < ${after.rank}::numeric OR (${tickets.rank} = ${after.rank}::numeric AND ${tickets.id} < ${after.id}))`
            : undefined,
        ),
      )
      .limit(1);
    if (gap)
      throw new ConflictException("Board order changed; refresh and retry");
    const rank =
      lower && upper
        ? sql`(${lower} + ${upper}) / 2`
        : lower
          ? sql`${lower} + 1000`
          : upper
            ? sql`${upper} - 1000`
            : sql`1000`;
    const [positionRow] = await tx.execute(sql`
      SELECT (${rank})::text AS rank,
        ${lower ? sql`(${rank}) > ${lower}` : sql`true`} AND
        ${upper ? sql`(${rank}) < ${upper}` : sql`true`} AS valid
    `);
    if (!positionRow?.valid)
      throw new ConflictException(
        "Rank gap exhausted or reversed; refresh board order",
      );
    const rankValue = String(positionRow?.rank ?? "");
    if (body.status !== undefined)
      await validateBatchTransition(
        tx,
        actor,
        projectId,
        [target],
        status,
        policy.role,
      );
    const now = new Date();
    const [updated] = await tx
      .update(tickets)
      .set({ rank: rankValue, status, updatedAt: now })
      .where(
        and(
          eq(tickets.orgId, actor.orgId),
          eq(tickets.projectId, projectId),
          eq(tickets.id, ticketId),
          isNull(tickets.deletedAt),
          body.version !== undefined
            ? eq(tickets.version, body.version)
            : undefined,
        ),
      )
      .returning({
        id: tickets.id,
        rank: tickets.rank,
        status: tickets.status,
        version: tickets.version,
      });
    if (!updated) {
      if (body.version !== undefined)
        throw new TicketVersionConflictException(target.version);
      throw new NotFoundException("Ticket not found");
    }
    if (body.status !== undefined)
      await emitBatchStatusChanges(
        tx,
        actor,
        projectId,
        [target],
        status,
        now,
        new Map([[updated.id, updated.version]]),
      );
    if (effectDeps) {
      await effectDeps.webhooksDispatch.enqueue(
        tx,
        actor.orgId,
        projectId,
        "ticket.updated",
        {
          id: ticketId,
          projectId,
          status,
          priority: target.priority ?? "MEDIUM",
          actor: actor.userId,
          timestamp: now.toISOString(),
        },
      );
      if (body.status !== undefined && body.status !== target.status) {
        await effectDeps.webhooksDispatch.enqueue(
          tx,
          actor.orgId,
          projectId,
          "ticket.status_changed",
          {
            id: ticketId,
            projectId,
            previousStatus: target.status,
            newStatus: status,
            actor: actor.userId,
            timestamp: now.toISOString(),
          },
        );
      }
    }
    capturedTarget = {
      priority: target.priority,
      dueDate: target.dueDate,
      points: target.points,
      cycleId: target.cycleId,
    };
    if (
      effectDeps?.dispatch !== undefined &&
      body.status === "IN_REVIEW" &&
      target.status !== "IN_REVIEW"
    ) {
      const [reviewRow] = await tx
        .select({ reporterId: tickets.reporterId, title: tickets.title })
        .from(tickets)
        .where(and(eq(tickets.orgId, actor.orgId), eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
        .limit(1);
      capturedReviewData = {
        reporterId: reviewRow?.reporterId ?? null,
        title: reviewRow?.title ?? "",
      };
    }
    previousStatus = target.status;
    return updated;
  });
  if (effectDeps) {
    const afterPayload = {
      ticketId,
      projectId,
      orgId: actor.orgId,
      status: result.status,
      actor: actor.userId,
    };
    effectDeps.automationRunner.runForTicketEvent(
      actor.orgId,
      projectId,
      "ticket.updated",
      afterPayload,
    );
    if (body.status !== undefined && result.status !== previousStatus) {
      effectDeps.automationRunner.runForTicketEvent(
        actor.orgId,
        projectId,
        "ticket.status_changed",
        afterPayload,
      );
    }
  }
  const beforeStatus = previousStatus;
  const ct = capturedTarget;
  const rankActivity = effectDeps?.activity;
  if (
    rankActivity !== undefined &&
    body.status !== undefined &&
    beforeStatus !== undefined &&
    result.status !== beforeStatus &&
    ct !== undefined
  ) {
    await withSavepoint(() =>
      rankActivity.logTicketFieldChanges(
        actor.orgId,
        ticketId,
        actor.userId,
        {
          title: "",
          status: beforeStatus,
          priority: ct.priority ?? "MEDIUM",
          assigneeId: null,
          dueDate: ct.dueDate ?? null,
          points: ct.points ?? null,
          type: "TASK",
          cycleId: ct.cycleId ?? null,
        },
        { status: result.status },
      )
    ).catch((error) => logger.error("Failed to log rank ticket activity", { error }));
  }
  const rd = capturedReviewData;
  const rankDispatch = effectDeps?.dispatch;
  if (rankDispatch !== undefined && rd !== undefined && rd.reporterId !== null) {
    await rankDispatch.emit({
      eventKey: "build.ticket.review_requested",
      orgId: actor.orgId,
      actorUserId: actor.userId,
      targetUserIds: [rd.reporterId],
      entityType: "ticket",
      entityId: String(ticketId),
      title: "Ticket ready for review",
      message: `Ticket "${rd.title}" changed to IN_REVIEW.`,
      link: buildTicketBoardHref(projectId, ticketId),
      variables: { ticketId, status: "IN_REVIEW", title: rd.title },
    });
  }
  await cache.invalidateNamespace(`build:analytics:${actor.orgId}`).catch(
    logSideEffectFailure("analytics cache eviction", {
      orgId: actor.orgId,
      projectId,
    }),
  );
  return result;
}
