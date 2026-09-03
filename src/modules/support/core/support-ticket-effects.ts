import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { registerAfterCommit, type AfterCommitHook } from "../../../common/tenant/tenant-context";
import type { AutomationService } from "../../automation/automation.service";
import type { SupportAiService } from "./support-ai.service";
import type { SupportNotificationsService } from "./support-notifications.service";
import type { SupportRealtimeService } from "./support-realtime.service";
import type { TicketPriority, UpdateTicketInput } from "./dto/support.schemas";

export interface AutomationTicketSnapshot {
  id: number;
  title: string;
  status: string;
  priority: string;
  category?: string | null;
  assigneeId?: string | null;
  assigneeMembershipId?: number | null;
}

export interface TicketCreatedEffectDeps {
  automations: AutomationService;
  ai: SupportAiService;
  notifications: SupportNotificationsService;
}

export interface TicketUpdatedEffectDeps {
  automations: AutomationService;
  notifications: SupportNotificationsService;
  realtime: SupportRealtimeService;
}

export interface TicketUpdateSnapshot {
  title: string;
  status: string;
  priority: string;
  category: string | null;
  assigneeUserId: string | undefined;
  creatorUserId: string;
}

export interface TicketCreatedEffectContext {
  orgId: string;
  userId: string;
  ticket: AutomationTicketSnapshot;
  title: string;
  priority: TicketPriority;
  assigneeId: string | undefined;
}

export interface TicketUpdatedEffectContext {
  orgId: string;
  ticketId: number;
  userId: string;
  updatedAt: Date;
  input: UpdateTicketInput;
  before: TicketUpdateSnapshot;
  applied: { status?: string; priority?: string };
}

export function buildAutomationPayload(ticket: AutomationTicketSnapshot): Record<string, unknown> {
  return {
    ticketId: ticket.id,
    title: ticket.title,
    status: ticket.status,
    priority: ticket.priority,
    category: ticket.category ?? null,
    assigneeId: null,
  };
}

/** Defer to commit where there is an ambient transaction, otherwise run inline. */
export function afterCommit(task: AfterCommitHook): void {
  if (!registerAfterCommit(task)) void task();
}

export function dispatchTicketCreatedEffects(
  deps: TicketCreatedEffectDeps,
  ctx: TicketCreatedEffectContext,
): void {
  const { orgId, userId, ticket, title, priority, assigneeId } = ctx;
  const ticketId = ticket.id;
  const payload = buildAutomationPayload(ticket);

  afterCommit(() =>
    deps.automations
      .runAutomationsForEvent(orgId, "ticket.created", payload)
      .catch(logSideEffectFailure("support automations on ticket.created", { orgId, ticketId })),
  );

  afterCommit(() =>
    deps.ai
      .runFullAnalysis(orgId, ticketId, userId)
      .catch(logSideEffectFailure("support AI analysis", { orgId, ticketId })),
  );

  if (assigneeId) {
    afterCommit(() =>
      deps.notifications
        .sendAssignmentEmail(orgId, assigneeId, userId, title, priority, ticketId, "User")
        .catch(logSideEffectFailure("support assignment email", { orgId, ticketId })),
    );
  }
}

export function dispatchTicketUpdatedEffects(
  deps: TicketUpdatedEffectDeps,
  ctx: TicketUpdatedEffectContext,
): void {
  const { orgId, ticketId, userId, updatedAt, input, before, applied } = ctx;

  void deps.realtime
    .publishTicketUpdated(orgId, ticketId, updatedAt)
    .catch(logSideEffectFailure("support realtime ticket-updated publish", { orgId, ticketId }));

  const updatedTicketForPayload: AutomationTicketSnapshot = {
    id: ticketId,
    title: before.title,
    status: applied.status ?? before.status,
    priority: applied.priority ?? before.priority,
    category: before.category,
    assigneeId: input.assigneeId !== undefined ? input.assigneeId : before.assigneeUserId,
  };

  if (input.status && input.status !== before.status) {
    afterCommit(() =>
      deps.automations
        .runAutomationsForEvent(orgId, "ticket.status_changed", buildAutomationPayload(updatedTicketForPayload))
        .catch(logSideEffectFailure("support automations on ticket.updated", { orgId, ticketId })),
    );
  }

  if (input.priority && input.priority !== before.priority) {
    afterCommit(() =>
      deps.automations
        .runAutomationsForEvent(orgId, "ticket.priority_changed", buildAutomationPayload(updatedTicketForPayload))
        .catch(logSideEffectFailure("support status-change notification", { orgId, ticketId })),
    );
  }

  const status = input.status;
  if (status) {
    afterCommit(() =>
      deps.notifications
        .sendStatusEmail(orgId, before.creatorUserId, userId, before.title, ticketId, status)
        .catch(logSideEffectFailure("support assignment notification", { orgId, ticketId })),
    );
  }

  const assigneeId = input.assigneeId;
  if (assigneeId && assigneeId !== before.assigneeUserId) {
    afterCommit(() =>
      deps.notifications
        .sendAssignmentEmail(orgId, assigneeId, userId, before.title, before.priority ?? "MEDIUM", ticketId, "Support")
        .catch(logSideEffectFailure("support SLA recalculation", { orgId, ticketId })),
    );
  }
}
