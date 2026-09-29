import { and, eq, inArray } from "drizzle-orm";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.types";
import { organizationMembers, tickets } from "../../../../db/schema";
import { logger } from "../../../../common/logger/logger.service";
import { withSavepoint } from "../../../data-quality/savepoint";
import { buildTicketBoardHref } from "../lib/build-app-paths";
import type { TicketEventPayload } from "../automation/build-automation-runner.service";
import type { DispatchEventInput } from "../../../notifications/notification.types";

export interface BulkTicketEffectDeps {
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
      changes: {
        status?: string;
        priority?: string;
        assigneeId?: string | null;
        cycleId?: number | null;
      },
    ): Promise<void>;
  };
  readonly dispatch?: {
    emit(input: DispatchEventInput): Promise<unknown>;
  };
  readonly transfer?: {
    notifyAssignedTickets(
      orgId: string,
      ticketIds: readonly number[],
      actingUserId: string,
      assigneeUserIds: readonly string[],
    ): Promise<void>;
  };
}

export interface BulkEffectRow {
  readonly id: number;
  readonly previousStatus: string | undefined;
  readonly effectiveStatus: string;
  readonly previousPriority: string;
  readonly previousDueDate: string | null;
  readonly previousPoints: number | null;
  readonly previousCycleId: number | null;
  readonly previousAssigneeUserId: string | null;
  readonly title: string;
  readonly type: string;
  readonly reporterId: string | null;
}

export interface BulkEffectChanges {
  readonly status?: string;
  readonly priority?: string;
  readonly assigneeUserId?: string | null;
  readonly cycleId?: number | null;
}

export function bulkEffectsNeedTicketMeta(
  effectDeps: BulkTicketEffectDeps | undefined,
): boolean {
  return effectDeps?.activity !== undefined || effectDeps?.dispatch !== undefined;
}

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
    .where(and(eq(tickets.orgId, orgId), inArray(tickets.id, unique)))
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

export async function dispatchBulkTicketEffects(
  effectDeps: BulkTicketEffectDeps,
  actor: CurrentUserContext,
  projectId: number,
  effectRows: readonly BulkEffectRow[],
  changes: BulkEffectChanges,
): Promise<void> {
  const nextStatus = changes.status;
  for (const row of effectRows) {
    const payload = {
      ticketId: row.id,
      projectId,
      orgId: actor.orgId,
      status: row.effectiveStatus,
    };
    effectDeps.automationRunner.runForTicketEvent(
      actor.orgId,
      projectId,
      "ticket.updated",
      payload,
    );
    if (
      nextStatus !== undefined &&
      row.previousStatus !== undefined &&
      row.previousStatus !== nextStatus
    )
      effectDeps.automationRunner.runForTicketEvent(
        actor.orgId,
        projectId,
        "ticket.status_changed",
        payload,
      );
  }

  const activity = effectDeps.activity;
  if (activity !== undefined) {
    for (const row of effectRows) {
      await withSavepoint(() =>
        activity.logTicketFieldChanges(
          actor.orgId,
          row.id,
          actor.userId,
          {
            title: row.title,
            status: row.previousStatus ?? row.effectiveStatus,
            priority: row.previousPriority,
            assigneeId: row.previousAssigneeUserId,
            dueDate: row.previousDueDate,
            points: row.previousPoints,
            type: row.type,
            cycleId: row.previousCycleId,
          },
          {
            status: changes.status,
            priority: changes.priority,
            assigneeId: changes.assigneeUserId,
            cycleId: changes.cycleId,
          },
        ),
      ).catch((error: unknown) =>
        logger.error("Failed to log bulk ticket activity", { error }),
      );
    }
  }

  const transfer = effectDeps.transfer;
  const newAssigneeUserId = changes.assigneeUserId;
  if (transfer !== undefined && newAssigneeUserId) {
    await withSavepoint(() =>
      transfer.notifyAssignedTickets(
        actor.orgId,
        effectRows.map((row) => row.id),
        actor.userId,
        [newAssigneeUserId],
      ),
    ).catch((error: unknown) =>
      logger.error("Failed to notify bulk ticket assignees", { error }),
    );
  }

  const dispatch = effectDeps.dispatch;
  if (
    dispatch === undefined ||
    (nextStatus !== "IN_REVIEW" && nextStatus !== "CHANGES_REQUESTED")
  )
    return;
  for (const row of effectRows) {
    if (row.previousStatus === nextStatus) continue;
    const target =
      nextStatus === "IN_REVIEW" ? row.reporterId : (newAssigneeUserId ?? null);
    if (!target) continue;
    await dispatch.emit({
      eventKey:
        nextStatus === "IN_REVIEW"
          ? "build.ticket.review_requested"
          : "build.ticket.changes_requested",
      orgId: actor.orgId,
      actorUserId: actor.userId,
      targetUserIds: [target],
      entityType: "ticket",
      entityId: String(row.id),
      title:
        nextStatus === "IN_REVIEW"
          ? "Ticket ready for review"
          : "Changes requested on your ticket",
      message: `Ticket "${row.title}" changed to ${nextStatus}.`,
      link: buildTicketBoardHref(projectId, row.id),
      variables: { ticketId: row.id, status: nextStatus, title: row.title },
    });
  }
}
