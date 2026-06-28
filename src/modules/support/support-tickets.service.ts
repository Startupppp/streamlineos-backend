import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import {
  supportTickets,
  supportTicketMessages,
  supportTicketActivity,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { logger } from "../../common/logger/logger.service";
import { SupportMacrosService } from "./support-macros.service";
import { SupportNotificationsService } from "./support-notifications.service";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import type {
  CreateTicketInput,
  ListTicketsInput,
  ReplyMessageInput,
  TicketPriority,
  TicketStatus,
  UpdateTicketInput,
} from "./dto/support.schemas";

type ListTicketsQuery = ListTicketsInput & { scope?: DataScope; userId?: string };

const TICKET_PRIORITIES: readonly TicketPriority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];

const SLA_HOURS: Record<TicketPriority, number> = {
  LOW: 48,
  MEDIUM: 24,
  HIGH: 8,
  URGENT: 2,
};

const ACTION_LABELS: Record<string, string> = {
  created: "created the ticket",
  status_changed: "changed status",
  priority_changed: "changed priority",
  assignee_changed: "changed assignee",
  replied: "replied",
  internal_note: "added an internal note",
  resolved: "resolved the ticket",
  reopened: "reopened the ticket",
};

type TicketActivityAction =
  | "status_changed"
  | "priority_changed"
  | "assignee_changed"
  | "resolved"
  | "reopened";

function isTicketPriority(value: string): value is TicketPriority {
  return (TICKET_PRIORITIES as readonly string[]).includes(value);
}

@Injectable()
export class SupportTicketsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly macros: SupportMacrosService,
    private readonly notifications: SupportNotificationsService,
  ) {}

  listTickets(orgId: string, query: ListTicketsQuery) {
    const { status, priority, assigneeId, page, limit, scope, userId } = query;
    const key = `support:tickets:${orgId}:${status ?? ""}:${priority ?? ""}:${assigneeId ?? ""}:${scope ?? ""}:${userId ?? ""}:${page}:${limit}`;
    return this.cache.cached(
      key,
      async () => {
        const offset = (page - 1) * limit;
        const conditions: SQL[] = [eq(supportTickets.orgId, orgId)];
        if (status) conditions.push(eq(supportTickets.status, status));
        if (priority) conditions.push(eq(supportTickets.priority, priority));
        if (assigneeId) conditions.push(eq(supportTickets.assigneeId, assigneeId));
        if (scope && scope !== "none" && userId) {
          conditions.push(applyScope(scope, userId, { ownerColumn: supportTickets.assigneeId }));
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

  async createTicket(orgId: string, userId: string, input: CreateTicketInput) {
    const existing = await this.db.query.supportTickets.findFirst({
      where: and(
        eq(supportTickets.orgId, orgId),
        sql`LOWER(${supportTickets.title}) = LOWER(${input.title})`,
      ),
      columns: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        "A ticket with this title already exists. Please use a different title.",
      );
    }

    const callerSetPriority = input.priority !== undefined;
    let finalPriority: TicketPriority = input.priority ?? "MEDIUM";
    let finalAssigneeId = input.assigneeId;

    try {
      const routing = await this.macros.applyRoutingRules(orgId, {
        title: input.title,
        category: input.category ?? null,
        description: input.description ?? null,
        priority: finalPriority,
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

    const slaHours = SLA_HOURS[finalPriority];
    const slaDeadline = new Date(Date.now() + slaHours * 60 * 60 * 1000);

    const [ticket] = await this.db
      .insert(supportTickets)
      .values({
        orgId,
        title: input.title,
        category: input.category ?? null,
        description: input.description ?? null,
        clientId: input.clientId ?? null,
        priority: finalPriority,
        assigneeId: finalAssigneeId ?? null,
        slaDeadline,
        createdBy: userId,
      })
      .returning();

    await this.invalidateTicketCaches(orgId);

    if (finalAssigneeId) {
      void this.notifications
        .sendAssignmentEmail(finalAssigneeId, userId, input.title, finalPriority, ticket.id, "User")
        .catch(() => undefined);
    }

    return ticket;
  }

  async getTicket(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      with: {
        client: true,
        assignee: { columns: { id: true, name: true, image: true } },
        creator: { columns: { id: true, name: true } },
        messages: {
          with: { author: { columns: { id: true, name: true, image: true } } },
          orderBy: [asc(supportTicketMessages.createdAt)],
        },
      },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    return ticket;
  }

  async updateTicket(orgId: string, ticketId: number, userId: string, input: UpdateTicketInput) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const updateData: Partial<typeof supportTickets.$inferInsert> = { updatedAt: new Date() };
    if (input.status) {
      updateData.status = input.status;
      if (input.status === "RESOLVED") updateData.resolvedAt = new Date();
      if (input.status === "CLOSED") updateData.closedAt = new Date();
    }
    if (input.priority) updateData.priority = input.priority;
    if (input.assigneeId !== undefined) updateData.assigneeId = input.assigneeId;

    await this.db
      .update(supportTickets)
      .set(updateData)
      .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)));

    await this.logTicketActivity(orgId, ticketId, userId, ticket, input);

    await this.invalidateTicketCaches(orgId);

    if (input.status) {
      void this.notifications
        .sendStatusEmail(ticket.createdBy, userId, ticket.title, ticketId, input.status)
        .catch(() => undefined);
    }

    if (input.assigneeId && input.assigneeId !== ticket.assigneeId) {
      void this.notifications
        .sendAssignmentEmail(
          input.assigneeId,
          userId,
          ticket.title,
          ticket.priority ?? "MEDIUM",
          ticketId,
          "Support",
        )
        .catch(() => undefined);
    }

    return { success: true };
  }

  async listMessages(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    return this.db.query.supportTicketMessages.findMany({
      where: eq(supportTicketMessages.ticketId, ticketId),
      with: { author: { columns: { id: true, name: true, image: true } } },
      orderBy: [asc(supportTicketMessages.createdAt)],
    });
  }

  async addMessage(orgId: string, ticketId: number, userId: string, input: ReplyMessageInput) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: { id: true, status: true, title: true, createdBy: true, assigneeId: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const [message] = await this.db
      .insert(supportTicketMessages)
      .values({
        ticketId,
        authorId: userId,
        body: input.body,
        isInternal: input.isInternal,
        attachments: input.attachments ?? [],
      })
      .returning();

    if (ticket.status === "OPEN") {
      await this.db
        .update(supportTickets)
        .set({ status: "IN_PROGRESS", updatedAt: new Date() })
        .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)));
    }

    if (!input.isInternal) {
      void this.notifications
        .sendReplyEmail(
          { title: ticket.title, createdBy: ticket.createdBy, assigneeId: ticket.assigneeId },
          ticketId,
          userId,
          input.body,
        )
        .catch(() => undefined);
    }

    return message;
  }

  async listActivity(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const rows = await this.db
      .select({
        id: supportTicketActivity.id,
        action: supportTicketActivity.action,
        fromValue: supportTicketActivity.fromValue,
        toValue: supportTicketActivity.toValue,
        createdAt: supportTicketActivity.createdAt,
        userId: supportTicketActivity.userId,
        userName: users.name,
        userImage: users.image,
      })
      .from(supportTicketActivity)
      .leftJoin(users, eq(supportTicketActivity.userId, users.id))
      .where(
        and(
          eq(supportTicketActivity.supportTicketId, ticketId),
          eq(supportTicketActivity.orgId, orgId),
        ),
      )
      .orderBy(desc(supportTicketActivity.createdAt));

    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      label: ACTION_LABELS[row.action] ?? row.action,
      fromValue: row.fromValue,
      toValue: row.toValue,
      createdAt: row.createdAt,
      userId: row.userId,
      userName: row.userName,
      userImage: row.userImage,
    }));
  }

  async stats(orgId: string) {
    const now = new Date();
    const [statusAggs, slaBreached] = await Promise.all([
      this.db
        .select({ status: supportTickets.status, cnt: count() })
        .from(supportTickets)
        .where(eq(supportTickets.orgId, orgId))
        .groupBy(supportTickets.status),
      this.db
        .select({ cnt: count() })
        .from(supportTickets)
        .where(
          and(
            eq(supportTickets.orgId, orgId),
            sql`${supportTickets.slaDeadline} IS NOT NULL`,
            lt(supportTickets.slaDeadline, now),
            sql`${supportTickets.status} NOT IN ('RESOLVED', 'CLOSED')`,
          ),
        ),
    ]);

    const statusMap = new Map(statusAggs.map((r) => [r.status, Number(r.cnt)]));

    return {
      open: statusMap.get("OPEN") ?? 0,
      in_progress: statusMap.get("IN_PROGRESS") ?? 0,
      waiting: statusMap.get("WAITING") ?? 0,
      resolved: statusMap.get("RESOLVED") ?? 0,
      closed: statusMap.get("CLOSED") ?? 0,
      sla_breached: Number(slaBreached[0]?.cnt ?? 0),
    };
  }

  private async logTicketActivity(
    orgId: string,
    ticketId: number,
    userId: string,
    previous: { status: TicketStatus; priority: TicketPriority | null; assigneeId: string | null },
    input: UpdateTicketInput,
  ) {
    const entries: { action: TicketActivityAction; fromValue: string | null; toValue: string | null }[] = [];

    if (input.status && input.status !== previous.status) {
      const action: TicketActivityAction =
        input.status === "RESOLVED"
          ? "resolved"
          : (previous.status === "RESOLVED" || previous.status === "CLOSED") &&
              input.status !== "CLOSED"
            ? "reopened"
            : "status_changed";
      entries.push({ action, fromValue: previous.status, toValue: input.status });
    }

    if (input.priority && input.priority !== previous.priority) {
      entries.push({
        action: "priority_changed",
        fromValue: previous.priority,
        toValue: input.priority,
      });
    }

    if (input.assigneeId !== undefined && input.assigneeId !== (previous.assigneeId ?? "")) {
      entries.push({
        action: "assignee_changed",
        fromValue: previous.assigneeId,
        toValue: input.assigneeId || null,
      });
    }

    if (entries.length === 0) return;

    try {
      await this.db.insert(supportTicketActivity).values(
        entries.map((entry) => ({
          orgId,
          supportTicketId: ticketId,
          userId,
          action: entry.action,
          fromValue: entry.fromValue,
          toValue: entry.toValue,
        })),
      );
    } catch (activityError) {
      logger.error("Failed to log support ticket activity", {
        ticketId,
        error: activityError instanceof Error ? activityError.message : String(activityError),
      });
    }
  }

  private async invalidateTicketCaches(orgId: string) {
    await this.cache.invalidatePattern(`support:tickets:${orgId}:*`);
    await this.cache.invalidate(CACHE_KEYS.supportDashboard(orgId));
    await this.cache.invalidate(CACHE_KEYS.ceDashboard(orgId));
  }
}
