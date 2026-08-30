import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { SupportTicketStaleException } from "../../../common/http/api-exceptions";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import {
  supportTicketLinks,
  supportTicketMessages,
  supportTickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { logger } from "../../../common/logger/logger.service";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SupportMacrosService } from "./support-macros.service";
import { SupportNotificationsService } from "./support-notifications.service";
import { SupportRealtimeService } from "./support-realtime.service";
import { SupportSlaService } from "./support-sla.service";
import { SupportAiService } from "./support-ai.service";
import { SupportCustomFieldsService } from "./support-custom-fields.service";
import { AutomationService } from "../../automation/automation.service";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import { SupportTicketActivityService } from "./support-ticket-activity.service";
import { SupportTicketMessagesService } from "./support-ticket-messages.service";
import { SupportTicketOperationsService } from "./support-ticket-operations.service";
import type {
  CreateTicketInput,
  CreateTicketLinkInput,
  ListTicketsInput,
  MergeTicketInput,
  ReplyMessageInput,
  SnoozeTicketInput,
  SplitTicketInput,
  TicketPriority,
  UpdateTicketInput,
} from "./dto/support.schemas";

type ListTicketsQuery = ListTicketsInput & { scope?: DataScope; userId?: string };

const TICKET_PRIORITIES: readonly TicketPriority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];

function isTicketPriority(value: string): value is TicketPriority {
  return (TICKET_PRIORITIES as readonly string[]).includes(value);
}

@Injectable()
export class SupportTicketsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly planLimits: PlanLimitsService,
    private readonly macros: SupportMacrosService,
    private readonly notifications: SupportNotificationsService,
    private readonly realtime: SupportRealtimeService,
    private readonly sla: SupportSlaService,
    private readonly automations: AutomationService,
    private readonly ai: SupportAiService,
    private readonly customFields: SupportCustomFieldsService,
    private readonly activity: SupportTicketActivityService,
    private readonly messages: SupportTicketMessagesService,
    private readonly operations: SupportTicketOperationsService,
  ) {}

  private buildAutomationPayload(ticket: {
    id: number;
    title: string;
    status: string;
    priority: string;
    category?: string | null;
    assigneeId?: string | null;
  }): Record<string, unknown> {
    return {
      ticketId: ticket.id,
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority,
      category: ticket.category ?? null,
      assigneeId: ticket.assigneeId ?? null,
    };
  }

  listTickets(orgId: string, query: ListTicketsQuery) {
    const { status, priority, assigneeId, queueId, channel, snoozed, page, limit, scope, userId } = query;
    const key = `${status ?? ""}:${priority ?? ""}:${assigneeId ?? ""}:${queueId ?? ""}:${channel ?? ""}:${snoozed ?? ""}:${scope ?? ""}:${userId ?? ""}:${page}:${limit}`;
    return this.cache.cachedVersioned(
      `support:tickets:${orgId}`,
      key,
      async () => {
        const offset = (page - 1) * limit;
        const conditions: SQL[] = [eq(supportTickets.orgId, orgId)];
        if (status) conditions.push(eq(supportTickets.status, status));
        if (priority) conditions.push(eq(supportTickets.priority, priority));
        if (assigneeId) conditions.push(eq(supportTickets.assigneeId, assigneeId));
        if (queueId) conditions.push(eq(supportTickets.queueId, queueId));
        if (channel) conditions.push(eq(supportTickets.sourceChannel, channel));
        if (snoozed === true) {
          conditions.push(sql`${supportTickets.snoozedUntil} > now()`);
        } else if (snoozed === false || snoozed === undefined) {
          const notSnoozed = or(isNull(supportTickets.snoozedUntil), sql`${supportTickets.snoozedUntil} <= now()`);
          if (notSnoozed) conditions.push(notSnoozed);
        }
        if (scope && scope !== "none" && userId) {
          conditions.push(applyScope(scope, orgId, userId, { ownerColumn: supportTickets.assigneeId }));
        } else if (scope === "none") {
          return { items: [], total: 0, page, totalPages: 0 };
        }

        const [items, [countResult]] = await Promise.all([
          this.db.query.supportTickets.findMany({
            where: and(...conditions),
            orderBy: [desc(supportTickets.createdAt)],
            limit,
            offset,
            with: {
              client: { columns: { id: true, name: true } },
              assignee: { columns: { id: true, name: true, image: true } },
              creator: { columns: { id: true, name: true } },
            },
          }),
          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(supportTickets)
            .where(and(...conditions)),
        ]);

        const total = countResult?.count ?? 0;
        return { items, total, page, totalPages: Math.ceil(total / limit) };
      },
      CACHE_TTL.SHORT,
    );
  }

  async createTicket(
    orgId: string,
    userId: string,
    input: CreateTicketInput,
    source?: {
      channel: string;
      messageId?: string | null;
      requesterEmail?: string | null;
      requesterName?: string | null;
    },
  ) {
    const possibleDuplicate = await this.db.query.supportTickets.findFirst({
      where: and(
        eq(supportTickets.orgId, orgId),
        sql`LOWER(${supportTickets.title}) = LOWER(${input.title})`,
        sql`${supportTickets.status} IN ('OPEN', 'IN_PROGRESS')`,
      ),
      columns: { id: true, title: true },
    });

    const callerSetPriority = input.priority !== undefined;
    let finalPriority: TicketPriority = input.priority ?? "MEDIUM";
    let finalAssigneeId = input.assigneeId;

    try {
      const isVip = await this.macros.isVipClient(orgId, input.clientId ?? null);
      const routing = await this.macros.applyRoutingRules(orgId, {
        title: input.title,
        category: input.category ?? null,
        description: input.description ?? null,
        priority: finalPriority,
        isVip,
      });
      if (routing.assigneeId && !input.assigneeId) {
        finalAssigneeId = routing.assigneeId;
      }
      if (routing.setPriority && !callerSetPriority && isTicketPriority(routing.setPriority)) {
        finalPriority = routing.setPriority;
      }
    } catch (routingError) {
      logger.error("Support routing rules failed to apply", {
        orgId,
        error: routingError instanceof Error ? routingError.message : String(routingError),
      });
    }

    await this.planLimits.assertWithinLimit(orgId, "supportTickets");

    const resolvedPolicy = await this.sla.resolvePolicy(orgId, finalPriority, input.category ?? null);
    const { firstResponseDueAt, resolutionDueAt } = this.sla.computeDueDates(resolvedPolicy, new Date());

    const ticket = await this.db.transaction(async (tx) => {
      const [row] = await (tx as Db)
        .insert(supportTickets)
        .values({
          orgId,
          title: input.title,
          category: input.category ?? null,
          description: input.description ?? null,
          clientId: input.clientId ?? null,
          priority: finalPriority,
          assigneeId: finalAssigneeId ?? null,
          slaDeadline: resolutionDueAt,
          firstResponseDueAt,
          createdBy: userId,
          sourceChannel: source?.channel ?? "web",
          sourceMessageId: source?.messageId ?? null,
          requesterEmail: source?.requesterEmail ?? null,
          requesterName: source?.requesterName ?? null,
        })
        .returning();
      return row;
    });

    await this.invalidateTicketCaches(orgId);
    await this.activity.recordActivity(orgId, ticket.id, userId, "created", null, input.title).catch(
      () => undefined,
    );
    await this.customFields.setFieldValues(orgId, ticket.id, input.customFields ?? [], true);

    const ticketAutomationPayload = this.buildAutomationPayload(ticket);
    const createdAutomationTask = () =>
      this.automations
        .runAutomationsForEvent(orgId, "ticket.created", ticketAutomationPayload)
        .catch(logSideEffectFailure("support automations on ticket.created", { orgId, ticketId: ticket.id }));
    if (!registerAfterCommit(createdAutomationTask)) void createdAutomationTask();

    const aiTask = () =>
      this.ai.runFullAnalysis(orgId, ticket.id).catch(logSideEffectFailure("support AI analysis", { orgId, ticketId: ticket.id }));
    if (!registerAfterCommit(aiTask)) void aiTask();

    if (finalAssigneeId) {
      const assignTask = () =>
        this.notifications
          .sendAssignmentEmail(orgId, finalAssigneeId, userId, input.title, finalPriority, ticket.id, "User")
          .catch(logSideEffectFailure("support assignment email", { orgId, ticketId: ticket.id }));
      if (!registerAfterCommit(assignTask)) void assignTask();
    }

    return {
      ...ticket,
      possibleDuplicateOf: possibleDuplicate
        ? { id: possibleDuplicate.id, title: possibleDuplicate.title }
        : null,
    };
  }

  async getTicket(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      with: {
        client: { columns: { id: true, name: true } },
        assignee: { columns: { id: true, name: true, image: true } },
        creator: { columns: { id: true, name: true } },
        messages: {
          with: { author: { columns: { id: true, name: true, image: true } } },
          orderBy: [asc(supportTicketMessages.createdAt)],
        },
      },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    const customFieldValues = await this.customFields.getFieldValues(orgId, ticketId);
    return { ...ticket, customFieldValues };
  }

  async updateTicket(orgId: string, ticketId: number, userId: string, input: UpdateTicketInput) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    if (input.expectedUpdatedAt && input.expectedUpdatedAt.getTime() !== ticket.updatedAt.getTime()) {
      throw new SupportTicketStaleException();
    }

    const ticketUpdatedAt = new Date();
    const updateData: Partial<typeof supportTickets.$inferInsert> = { updatedAt: ticketUpdatedAt };
    if (input.status) {
      updateData.status = input.status;
      if (input.status === "RESOLVED") updateData.resolvedAt = new Date();
      if (input.status === "CLOSED") updateData.closedAt = new Date();

      const policy = await this.sla.resolvePolicy(orgId, ticket.priority, ticket.category);
      const pauseTransition = this.sla.computePauseTransition(
        ticket.status,
        input.status,
        policy.pauseStatuses,
        ticket.slaPausedAt,
        ticket.slaPausedMinutes,
      );
      updateData.slaPausedAt = pauseTransition.slaPausedAt;
      updateData.slaPausedMinutes = pauseTransition.slaPausedMinutes;
      if (pauseTransition.extendByMinutes > 0) {
        const extendMs = pauseTransition.extendByMinutes * 60_000;
        if (!ticket.firstRespondedAt && ticket.firstResponseDueAt) {
          updateData.firstResponseDueAt = new Date(ticket.firstResponseDueAt.getTime() + extendMs);
        }
        if (ticket.slaDeadline) {
          updateData.slaDeadline = new Date(ticket.slaDeadline.getTime() + extendMs);
        }
      }
    }
    if (input.priority) updateData.priority = input.priority;
    if (input.assigneeId !== undefined) updateData.assigneeId = input.assigneeId;
    if (input.queueId !== undefined) updateData.queueId = input.queueId;

    await this.db.transaction(async (tx) => {
      await (tx as Db)
        .update(supportTickets)
        .set(updateData)
        .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)));
      if (updateData.status === "RESOLVED") {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "support_ticket",
          aggregateId: String(ticketId),
          aggregateVersion: ticketUpdatedAt.getTime(),
          eventType: "support.ticket.resolved",
          payload: { ticketId, orgId, actorUserId: userId },
          occurredAt: ticketUpdatedAt,
        });
      }
    });

    await this.activity.logTicketActivity(orgId, ticketId, userId, ticket, input);
    if (input.customFields) {
      await this.customFields.setFieldValues(orgId, ticketId, input.customFields, false);
    }

    await this.invalidateTicketCaches(orgId);

    void this.realtime.publishTicketUpdated(orgId, ticketId, ticketUpdatedAt).catch(logSideEffectFailure("support realtime ticket-updated publish", { orgId, ticketId }));

    const updatedTicketForPayload = {
      id: ticketId,
      title: ticket.title,
      status: updateData.status ?? ticket.status,
      priority: updateData.priority ?? ticket.priority,
      category: ticket.category,
      assigneeId: updateData.assigneeId !== undefined ? updateData.assigneeId : ticket.assigneeId,
    };

    if (input.status && input.status !== ticket.status) {
      const statusAutomationTask = () =>
        this.automations
          .runAutomationsForEvent(orgId, "ticket.status_changed", this.buildAutomationPayload(updatedTicketForPayload))
          .catch(logSideEffectFailure("support automations on ticket.updated", { orgId, ticketId }));
      if (!registerAfterCommit(statusAutomationTask)) void statusAutomationTask();
    }
    if (input.priority && input.priority !== ticket.priority) {
      const priorityAutomationTask = () =>
        this.automations
          .runAutomationsForEvent(orgId, "ticket.priority_changed", this.buildAutomationPayload(updatedTicketForPayload))
          .catch(logSideEffectFailure("support status-change notification", { orgId, ticketId }));
      if (!registerAfterCommit(priorityAutomationTask)) void priorityAutomationTask();
    }

    if (input.status) {
      const statusNotifTask = () =>
        this.notifications
          .sendStatusEmail(orgId, ticket.createdBy, userId, ticket.title, ticketId, input.status!)
          .catch(logSideEffectFailure("support assignment notification", { orgId, ticketId }));
      if (!registerAfterCommit(statusNotifTask)) void statusNotifTask();
    }

    if (input.assigneeId && input.assigneeId !== ticket.assigneeId) {
      const assignNotifTask = () =>
        this.notifications
          .sendAssignmentEmail(
            orgId,
            input.assigneeId!,
            userId,
            ticket.title,
            ticket.priority ?? "MEDIUM",
            ticketId,
            "Support",
          )
          .catch(logSideEffectFailure("support SLA recalculation", { orgId, ticketId }));
      if (!registerAfterCommit(assignNotifTask)) void assignNotifTask();
    }

    return { success: true, updatedAt: updateData.updatedAt };
  }

  async splitTicket(orgId: string, ticketId: number, userId: string, input: SplitTicketInput) {
    const original = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: { id: true, category: true, clientId: true, priority: true, requesterEmail: true, requesterName: true },
    });
    if (!original) throw new NotFoundException("Ticket not found");

    const newTicket = await this.createTicket(orgId, userId, {
      title: input.title,
      description: input.description,
      category: original.category ?? undefined,
      clientId: original.clientId ?? undefined,
      priority: original.priority,
    });

    await this.db
      .insert(supportTicketLinks)
      .values({ orgId, ticketId: newTicket.id, linkedTicketId: ticketId, relation: "split", createdBy: userId })
      .onConflictDoNothing();

    await this.activity.recordActivity(orgId, ticketId, userId, "split", null, String(newTicket.id));
    await this.activity.recordActivity(orgId, newTicket.id, userId, "split", String(ticketId), null);

    return newTicket;
  }

  listMessages(orgId: string, ticketId: number) {
    return this.messages.listMessages(orgId, ticketId);
  }

  listPublicMessages(orgId: string, ticketId: number) {
    return this.messages.listPublicMessages(orgId, ticketId);
  }

  addMessage(
    orgId: string,
    ticketId: number,
    userId: string | null,
    input: ReplyMessageInput,
    source?: { channel: string; messageId?: string | null; contactEmail?: string | null; contactName?: string | null },
  ) {
    return this.messages.addMessage(orgId, ticketId, userId, input, source);
  }

  listActivity(orgId: string, ticketId: number) {
    return this.activity.listActivity(orgId, ticketId);
  }

  stats(orgId: string) {
    return this.activity.stats(orgId);
  }

  addTicketLink(orgId: string, ticketId: number, userId: string, input: CreateTicketLinkInput) {
    return this.operations.addTicketLink(orgId, ticketId, userId, input);
  }

  listTicketLinks(orgId: string, ticketId: number) {
    return this.operations.listTicketLinks(orgId, ticketId);
  }

  mergeTicket(orgId: string, ticketId: number, userId: string, input: MergeTicketInput) {
    return this.operations.mergeTicket(orgId, ticketId, userId, input);
  }

  snoozeTicket(orgId: string, ticketId: number, userId: string, input: SnoozeTicketInput) {
    return this.operations.snoozeTicket(orgId, ticketId, userId, input);
  }

  unsnoozeTicket(orgId: string, ticketId: number, userId: string) {
    return this.operations.unsnoozeTicket(orgId, ticketId, userId);
  }

  unsnoozeExpiredTickets() {
    return this.operations.unsnoozeExpiredTickets();
  }

  private async invalidateTicketCaches(orgId: string) {
    await this.cache.invalidateNamespace(`support:tickets:${orgId}`);
    await this.cache.invalidate(CACHE_KEYS.supportDashboard(orgId));
    await this.cache.invalidate(CACHE_KEYS.ceDashboard(orgId));
  }
}
