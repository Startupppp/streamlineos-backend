import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { logger } from "../../../../common/logger/logger.service";
import { withSavepoint } from "../../../data-quality/savepoint";
import { buildTicketBoardHref } from "../lib/build-app-paths";
import type { TicketEventPayload } from "../automation/build-automation-runner.service";
import type { DispatchEventInput } from "../../../notifications/notification.types";

export interface TicketChangeSnapshot {
  readonly title: string;
  readonly status: string;
  readonly priority: string;
  readonly assigneeId: string | null;
  readonly dueDate: string | null;
  readonly points: number | null;
  readonly type: string;
  readonly cycleId: number | null;
}

export type TicketChangeFields = Partial<TicketChangeSnapshot>;

export interface TicketChangeEffectRow {
  readonly id: number;
  readonly reporterId: string | null;
  readonly before: TicketChangeSnapshot;
}

export interface TicketChangeEffectDeps {
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
  readonly activity: {
    logTicketFieldChanges(
      orgId: string,
      ticketId: number,
      userId: string,
      before: TicketChangeSnapshot,
      changes: TicketChangeFields,
    ): Promise<void>;
  };
  readonly dispatch: {
    emit(input: DispatchEventInput): Promise<unknown>;
  };
  readonly transfer: {
    notifyAssignedTickets(
      orgId: string,
      ticketIds: readonly number[],
      actingUserId: string,
      assigneeUserIds: readonly string[],
    ): Promise<void>;
  };
}

export function ticketChangeStatusChanged(
  row: TicketChangeEffectRow,
  changes: TicketChangeFields,
): boolean {
  return changes.status !== undefined && changes.status !== row.before.status;
}

function assigneeChanged(
  row: TicketChangeEffectRow,
  changes: TicketChangeFields,
): boolean {
  return (
    changes.assigneeId !== undefined && changes.assigneeId !== row.before.assigneeId
  );
}

export function ticketChangePayload(
  row: TicketChangeEffectRow,
  orgId: string,
  projectId: number,
  changes: TicketChangeFields,
): TicketEventPayload {
  return {
    ticketId: row.id,
    projectId,
    orgId,
    status: changes.status ?? row.before.status,
    priority: changes.priority ?? row.before.priority,
    assigneeId:
      changes.assigneeId !== undefined ? changes.assigneeId : row.before.assigneeId,
    title: changes.title ?? row.before.title,
    type: changes.type ?? row.before.type,
  };
}

export async function enqueueTicketChangeWebhooks(
  deps: Pick<TicketChangeEffectDeps, "webhooksDispatch">,
  actor: CurrentUserContext,
  projectId: number,
  tx: unknown,
  rows: readonly TicketChangeEffectRow[],
  changes: TicketChangeFields,
  now: Date,
): Promise<void> {
  const timestamp = now.toISOString();
  for (const row of rows) {
    const next = ticketChangePayload(row, actor.orgId, projectId, changes);
    await deps.webhooksDispatch.enqueue(
      tx,
      actor.orgId,
      projectId,
      "ticket.updated",
      {
        id: row.id,
        projectId,
        title: next.title,
        status: next.status,
        priority: next.priority,
        actor: actor.userId,
        timestamp,
      },
    );
    if (ticketChangeStatusChanged(row, changes))
      await deps.webhooksDispatch.enqueue(
        tx,
        actor.orgId,
        projectId,
        "ticket.status_changed",
        {
          id: row.id,
          projectId,
          previousStatus: row.before.status,
          newStatus: next.status,
          actor: actor.userId,
          timestamp,
        },
      );
    if (assigneeChanged(row, changes))
      await deps.webhooksDispatch.enqueue(
        tx,
        actor.orgId,
        projectId,
        "ticket.assigned",
        {
          id: row.id,
          projectId,
          title: next.title,
          status: next.status,
          assigneeId: changes.assigneeId ?? null,
          actor: actor.userId,
          timestamp,
        },
      );
  }
}

export async function dispatchTicketChangeEffects(
  deps: TicketChangeEffectDeps,
  actor: CurrentUserContext,
  projectId: number,
  rows: readonly TicketChangeEffectRow[],
  changes: TicketChangeFields,
  notifyAssigneeUserIds: readonly string[],
): Promise<void> {
  for (const row of rows) {
    const payload = ticketChangePayload(row, actor.orgId, projectId, changes);
    deps.automationRunner.runForTicketEvent(
      actor.orgId,
      projectId,
      "ticket.updated",
      payload,
    );
    if (ticketChangeStatusChanged(row, changes))
      deps.automationRunner.runForTicketEvent(
        actor.orgId,
        projectId,
        "ticket.status_changed",
        payload,
      );
    if (assigneeChanged(row, changes))
      deps.automationRunner.runForTicketEvent(
        actor.orgId,
        projectId,
        "ticket.assigned",
        payload,
      );
  }

  for (const row of rows)
    await withSavepoint(() =>
      deps.activity.logTicketFieldChanges(
        actor.orgId,
        row.id,
        actor.userId,
        row.before,
        changes,
      ),
    ).catch((error: unknown) =>
      logger.error("Failed to log ticket activity", { error }),
    );

  await withSavepoint(() =>
      deps.transfer.notifyAssignedTickets(
        actor.orgId,
        rows.map((row) => row.id),
        actor.userId,
        notifyAssigneeUserIds,
      ),
    ).catch((error: unknown) =>
      logger.error("Failed to notify ticket assignees", { error }),
    );

  const next = changes.status;
  if (next !== "IN_REVIEW" && next !== "CHANGES_REQUESTED") return;
  for (const row of rows) {
    if (!ticketChangeStatusChanged(row, changes)) continue;
    const target =
      next === "IN_REVIEW"
        ? row.reporterId
        : (changes.assigneeId ?? row.before.assigneeId);
    if (!target) continue;
    await deps.dispatch.emit({
      eventKey:
        next === "IN_REVIEW"
          ? "build.ticket.review_requested"
          : "build.ticket.changes_requested",
      orgId: actor.orgId,
      actorUserId: actor.userId,
      targetUserIds: [target],
      entityType: "ticket",
      entityId: String(row.id),
      title:
        next === "IN_REVIEW"
          ? "Ticket ready for review"
          : "Changes requested on your ticket",
      message: `Ticket "${row.before.title}" changed to ${next}.`,
      link: buildTicketBoardHref(projectId, row.id),
      variables: { ticketId: row.id, status: next, title: row.before.title },
    });
  }
}
