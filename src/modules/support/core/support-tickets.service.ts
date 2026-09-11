import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { partyNamesFor } from "../../party/party-names";
import { SupportTicketStaleException } from "../../../common/http/api-exceptions";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { supportTicketLinks, supportTicketMessages, supportTickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SupportMacrosService } from "./support-macros.service";
import { SupportNotificationsService } from "./support-notifications.service";
import { SupportRealtimeService } from "./support-realtime.service";
import { SupportSlaService } from "./support-sla.service";
import { SupportAiService } from "./support-ai.service";
import { SupportCustomFieldsService } from "./support-custom-fields.service";
import { AutomationService } from "../../automation/automation.service";
import type { ScopedRead } from "../../access/scoped-read";
import { SupportTicketActivityService } from "./support-ticket-activity.service";
import { SupportTicketMessagesService } from "./support-ticket-messages.service";
import { SupportTicketOperationsService } from "./support-ticket-operations.service";
import {
  ticketListFilters,
  ticketListCacheKey,
  type ListTicketsQuery,
} from "./support-ticket-list-query";
import { supportTicketScope } from "./support-tickets-scope";
import { resolveTicketRouting } from "./support-ticket-routing";
import {
  insertTicketWithOpeningMessage,
  resolveActiveMembershipId,
  type TicketSource,
} from "./support-ticket-writes";
import { buildTicketUpdateData } from "./support-ticket-update-plan";
import {
  dispatchTicketCreatedEffects,
  dispatchTicketUpdatedEffects,
} from "./support-ticket-effects";
import type {
  CreateTicketInput,
  CreateTicketLinkInput,
  MergeTicketInput,
  ReplyMessageInput,
  SnoozeTicketInput,
  SplitTicketInput,
  TicketAttachmentInput,
  UpdateTicketInput,
} from "./dto/support.schemas";

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

  listTickets(orgId: string, query: ListTicketsQuery) {
    const { page, limit } = query;
    return this.cache.cachedVersioned(
      `support:tickets:${orgId}`,
      ticketListCacheKey(query),
      async () => {
        const offset = (page - 1) * limit;
        return query.read.read(
          {
            tenant: supportTickets.orgId,
            scope: supportTicketScope(orgId, query.read.actorId),
            and: ticketListFilters(orgId, query),
          },
          async ({ sql: where }) => {
            const [items, [countResult]] = await Promise.all([
              this.db.query.supportTickets.findMany({
                where,
                orderBy: [desc(supportTickets.createdAt)],
                limit,
                offset,
                with: {
                  assigneeMembership: { columns: { id: true }, with: { user: { columns: { id: true, name: true, image: true } } } },
                  creatorMembership: { columns: { id: true }, with: { user: { columns: { id: true, name: true } } } },
                },
              }),
              this.db
                .select({ count: sql<number>`count(*)::int` })
                .from(supportTickets)
                .where(where),
            ]);

            /**
             * The client's name from Party, not from `clients`. Ticket 08.
             *
             * `client_id` is still what the ticket is filed under and is still
             * returned as `client.id`, so nothing downstream changes shape; only the
             * name moved. That is all this service read the legacy table for.
             */
            const names = await partyNamesFor(this.db, orgId, items.map((t) => t.clientPartyId));
            const withClient = items.map((t) => ({
              ...t,
              client: t.clientId
                ? { id: t.clientId, name: t.clientPartyId ? (names.get(t.clientPartyId) ?? null) : null }
                : null,
            }));

            const total = countResult?.count ?? 0;
            return { items: withClient, total, page, totalPages: Math.ceil(total / limit) };
          },
          () => ({ items: [], total: 0, page, totalPages: 0 }),
        );
      },
      CACHE_TTL.SHORT,
    );
  }

  async createTicket(
    orgId: string,
    userId: string,
    input: CreateTicketInput & { attachments?: TicketAttachmentInput[] },
    source?: TicketSource,
    membershipId?: number | null,
  ) {
    if (membershipId == null) throw new ForbiddenException("Organization membership required");
    const possibleDuplicate = await this.db.query.supportTickets.findFirst({
      where: and(
        eq(supportTickets.orgId, orgId),
        sql`LOWER(${supportTickets.title}) = LOWER(${input.title})`,
        sql`${supportTickets.status} IN ('OPEN', 'IN_PROGRESS')`,
      ),
      columns: { id: true, title: true },
    });

    const routing = await resolveTicketRouting(this.macros, orgId, input);

    await this.planLimits.assertWithinLimit(orgId, "supportTickets");

    const resolvedPolicy = await this.sla.resolvePolicy(orgId, routing.priority, input.category ?? null);
    const { firstResponseDueAt, resolutionDueAt } = this.sla.computeDueDates(resolvedPolicy, new Date());

    const ticket = await this.db.transaction(async (tx) =>
      insertTicketWithOpeningMessage(tx, {
        orgId,
        userId,
        input,
        priority: routing.priority,
        assigneeId: routing.assigneeId,
        membershipId,
        firstResponseDueAt,
        resolutionDueAt,
        source,
      }),
    );

    await this.invalidateTicketCaches(orgId);
    await this.activity.recordActivity(orgId, ticket.id, userId, "created", null, input.title).catch(
      () => undefined,
    );
    await this.customFields.setFieldValues(orgId, ticket.id, input.customFields ?? [], true);

    dispatchTicketCreatedEffects(
      { automations: this.automations, ai: this.ai, notifications: this.notifications },
      {
        orgId,
        userId,
        ticket,
        title: input.title,
        priority: routing.priority,
        assigneeId: routing.assigneeId,
      },
    );

    return {
      ...ticket,
      possibleDuplicateOf: possibleDuplicate
        ? { id: possibleDuplicate.id, title: possibleDuplicate.title }
        : null,
    };
  }

  async getTicket(orgId: string, ticketId: number, read: ScopedRead) {
    const ticket = await read.read(
      {
        tenant: supportTickets.orgId,
        scope: supportTicketScope(orgId, read.actorId),
        and: [eq(supportTickets.id, ticketId)],
      },
      ({ sql: where }) => this.db.query.supportTickets.findFirst({
        where,
        with: {
          assigneeMembership: { columns: { id: true }, with: { user: { columns: { id: true, name: true, image: true } } } },
          creatorMembership: { columns: { id: true }, with: { user: { columns: { id: true, name: true } } } },
          messages: {
            with: { author: { columns: { id: true, name: true, image: true } } },
            orderBy: [asc(supportTicketMessages.createdAt)],
          },
        },
      }),
      () => undefined,
    );
    // Same tenant but out of scope is a permission answer, not an existence one, so the fallback read decides which.
    if (!ticket) {
      const exists = await this.db.query.supportTickets.findFirst({
        where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
        columns: { id: true },
      });
      if (exists) throw new ForbiddenException("Not authorized to view this ticket");
      throw new NotFoundException("Ticket not found");
    }
    const customFieldValues = await this.customFields.getFieldValues(orgId, ticketId);

    // Same as the list path: the identifier stays, the name comes from Party.
    const names = await partyNamesFor(this.db, orgId, [ticket.clientPartyId]);
    const client = ticket.clientId
      ? {
          id: ticket.clientId,
          name: ticket.clientPartyId ? (names.get(ticket.clientPartyId) ?? null) : null,
        }
      : null;

    return { ...ticket, client, customFieldValues };
  }

  async updateTicket(orgId: string, ticketId: number, userId: string, input: UpdateTicketInput) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      with: {
        assigneeMembership: { columns: { id: true }, with: { user: { columns: { id: true } } } },
        creatorMembership: { columns: { id: true }, with: { user: { columns: { id: true } } } },
      },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    if (input.expectedUpdatedAt && input.expectedUpdatedAt.getTime() !== ticket.updatedAt.getTime()) {
      throw new SupportTicketStaleException();
    }

    const ticketUpdatedAt = new Date();
    const assigneeMembershipId =
      input.assigneeId !== undefined
        ? await resolveActiveMembershipId(this.db, orgId, input.assigneeId)
        : undefined;
    const updateData = await buildTicketUpdateData(
      this.sla,
      orgId,
      ticket,
      input,
      ticketUpdatedAt,
      assigneeMembershipId,
    );

    await this.db.transaction(async (tx) => {
      await tx
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

    await this.activity.logTicketActivity(orgId, ticketId, userId, { ...ticket, assigneeId: ticket.assigneeMembership?.user?.id ?? null }, input);
    if (input.customFields) {
      await this.customFields.setFieldValues(orgId, ticketId, input.customFields, false);
    }

    await this.invalidateTicketCaches(orgId);

    dispatchTicketUpdatedEffects(
      { automations: this.automations, notifications: this.notifications, realtime: this.realtime },
      {
        orgId,
        ticketId,
        userId,
        updatedAt: ticketUpdatedAt,
        input,
        before: {
          title: ticket.title,
          status: ticket.status,
          priority: ticket.priority,
          category: ticket.category,
          assigneeUserId: ticket.assigneeMembership?.user?.id,
          creatorUserId: ticket.creatorMembership?.user?.id ?? null,
        },
        applied: { status: updateData.status, priority: updateData.priority },
      },
    );

    return { success: true, updatedAt: updateData.updatedAt };
  }

  async splitTicket(orgId: string, ticketId: number, userId: string, input: SplitTicketInput, membershipId?: number | null) {
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
    }, undefined, membershipId);

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
