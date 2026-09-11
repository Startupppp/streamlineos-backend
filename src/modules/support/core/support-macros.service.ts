import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import {
  supportMacros,
  supportTickets,
  supportAgentSkills,
  supportAgentAvailability,
  supportVipClients,
  users,
  organizations,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { appUrl } from "../../email/app-url";
import {
  applyRoutingRules,
  createRoutingRule,
  deleteRoutingRule,
  listRoutingRules,
  updateRoutingRule,
  type RoutableTicket,
  type RoutingOutcome,
} from "./lib/support-routing";
import type {
  ApplyMacroInput,
  CreateMacroInput,
  CreateRoutingRuleInput,
  ListMacrosInput,
  UpdateMacroInput,
  UpdateRoutingRuleInput,
} from "./dto/support.schemas";

export type { RoutableTicket, RoutingOutcome } from "./lib/support-routing";

/**
 * Macros (canned agent replies) and the support agent roster that routing
 * draws its candidates from — skills, availability and the VIP client list.
 *
 * The routing rules themselves, and the engine that picks an assignee, live
 * in `lib/support-routing.ts`; the five members below are thin delegates
 * kept because `SupportTicketsService` and `SupportSlaService` inject this
 * service, not the lib.
 */
@Injectable()
export class SupportMacrosService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listMacros(orgId: string, userId: string, membershipId: number | null, query: ListMacrosInput) {
    const privateVisible = membershipId != null
      ? eq(supportMacros.createdByMembershipId, membershipId)
      : eq(supportMacros.createdBy, userId);
    const conditions = [
      eq(supportMacros.orgId, orgId),
      or(sql`${supportMacros.visibility} != 'private'`, privateVisible)!,
    ];
    if (query.category) conditions.push(eq(supportMacros.category, query.category));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(ilike(supportMacros.title, term), ilike(supportMacros.body, term));
      if (match) conditions.push(match);
    }

    return this.db.query.supportMacros.findMany({
      where: and(...conditions),
      orderBy: [asc(supportMacros.title)],
      limit: 100,
    });
  }

  async createMacro(orgId: string, userId: string, membershipId: number | null, input: CreateMacroInput) {
    const [macro] = await this.db
      .insert(supportMacros)
      .values({
        orgId,
        title: input.title,
        body: input.body,
        category: input.category ?? null,
        visibility: input.visibility,
        actions: input.actions,
        createdBy: userId,
        createdByMembershipId: membershipId ?? undefined,
      })
      .returning();
    return macro;
  }

  async updateMacro(orgId: string, macroId: number, input: UpdateMacroInput) {
    const [updated] = await this.db
      .update(supportMacros)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(supportMacros.id, macroId), eq(supportMacros.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Macro not found");
    return updated;
  }

  async deleteMacro(orgId: string, macroId: number) {
    const [deleted] = await this.db
      .delete(supportMacros)
      .where(and(eq(supportMacros.id, macroId), eq(supportMacros.orgId, orgId)))
      .returning();

    if (!deleted) throw new NotFoundException("Macro not found");
    return { success: true };
  }

  /**
   * Renders {{customer.name}}/{{ticket.id}}/{{agent.name}}/{{company.name}}/
   * {{portal.link}} against the given ticket — no side effects, no usage
   * bump. Used for the compose-time preview before an agent sends a reply.
   */
  async previewMacro(orgId: string, macroId: number, userId: string, membershipId: number | null, ticketId: number): Promise<{ body: string }> {
    const macro = await this.db.query.supportMacros.findFirst({
      where: and(eq(supportMacros.id, macroId), eq(supportMacros.orgId, orgId)),
      columns: { id: true, body: true, visibility: true, createdBy: true, createdByMembershipId: true },
    });
    if (!macro) throw new NotFoundException("Macro not found");
    const isCreator = membershipId != null && macro.createdByMembershipId != null
      ? macro.createdByMembershipId === membershipId
      : macro.createdBy === userId;
    if (macro.visibility === "private" && !isCreator) {
      throw new ForbiddenException("This macro is private to its creator");
    }

    const rendered = await this.renderMacroBody(orgId, userId, ticketId, macro.body);
    return { body: rendered };
  }

  /**
   * Renders the macro AND applies its configured actions (status/priority/tag)
   * to the ticket in one call. Does not post the rendered body as a message —
   * the caller (ticket reply flow) is responsible for that, since whether it's
   * a public reply or internal note is a choice made at send time, not baked
   * into the macro itself.
   */
  async applyMacro(orgId: string, macroId: number, userId: string, membershipId: number | null, input: ApplyMacroInput) {
    const macro = await this.db.query.supportMacros.findFirst({
      where: and(eq(supportMacros.id, macroId), eq(supportMacros.orgId, orgId)),
    });
    if (!macro) throw new NotFoundException("Macro not found");
    const isCreator = membershipId != null && macro.createdByMembershipId != null
      ? macro.createdByMembershipId === membershipId
      : macro.createdBy === userId;
    if (macro.visibility === "private" && !isCreator) {
      throw new ForbiddenException("This macro is private to its creator");
    }

    const rendered = await this.renderMacroBody(orgId, userId, input.ticketId, macro.body);

    const ticketUpdate: Partial<typeof supportTickets.$inferInsert> = {};
    if (macro.actions?.setStatus) ticketUpdate.status = macro.actions.setStatus as (typeof supportTickets.$inferInsert)["status"];
    if (macro.actions?.setPriority) ticketUpdate.priority = macro.actions.setPriority as (typeof supportTickets.$inferInsert)["priority"];
    if (Object.keys(ticketUpdate).length > 0) {
      ticketUpdate.updatedAt = new Date();
      await this.db
        .update(supportTickets)
        .set(ticketUpdate)
        .where(and(eq(supportTickets.id, input.ticketId), eq(supportTickets.orgId, orgId)));
    }

    await this.db
      .update(supportMacros)
      .set({ usageCount: sql`${supportMacros.usageCount} + 1` })
      .where(and(eq(supportMacros.id, macroId), eq(supportMacros.orgId, orgId)));

    return { body: rendered, isInternal: macro.actions?.isInternal ?? false, actionsApplied: macro.actions ?? {} };
  }

  async getUsage(orgId: string) {
    return this.db
      .select({ id: supportMacros.id, title: supportMacros.title, usageCount: supportMacros.usageCount })
      .from(supportMacros)
      .where(eq(supportMacros.orgId, orgId))
      .orderBy(sql`${supportMacros.usageCount} DESC`)
      .limit(50);
  }

  private async renderMacroBody(orgId: string, userId: string, ticketId: number, body: string): Promise<string> {
    const [ticket, agent, org] = await Promise.all([
      this.db.query.supportTickets.findFirst({
        where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
        columns: { id: true, requesterName: true, createdBy: true },
        with: { creator: { columns: { name: true } } },
      }),
      this.db.query.users.findFirst({ where: eq(users.id, userId), columns: { name: true } }),
      this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { name: true } }),
    ]);
    if (!ticket) throw new NotFoundException("Ticket not found");

    const customerName = ticket.requesterName ?? ticket.creator?.name ?? "there";
    const variables: Record<string, string> = {
      "customer.name": customerName,
      "ticket.id": String(ticket.id),
      "agent.name": agent?.name ?? "Support",
      "company.name": org?.name ?? "our team",
      "portal.link": `${appUrl()}/support/portal/tickets/${ticket.id}`,
    };

    return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => variables[key] ?? match);
  }

  listRoutingRules(orgId: string) {
    return listRoutingRules(this.db, orgId);
  }

  createRoutingRule(orgId: string, userId: string, input: CreateRoutingRuleInput) {
    return createRoutingRule(this.db, orgId, userId, input);
  }

  updateRoutingRule(orgId: string, ruleId: number, input: UpdateRoutingRuleInput) {
    return updateRoutingRule(this.db, orgId, ruleId, input);
  }

  deleteRoutingRule(orgId: string, ruleId: number) {
    return deleteRoutingRule(this.db, orgId, ruleId);
  }

  applyRoutingRules(orgId: string, ticket: RoutableTicket): Promise<RoutingOutcome> {
    return applyRoutingRules(this.db, orgId, ticket);
  }

  async setAgentSkills(orgId: string, userId: string, skills: string[]) {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(supportAgentSkills)
        .where(and(eq(supportAgentSkills.orgId, orgId), eq(supportAgentSkills.userId, userId)));
      if (skills.length > 0) {
        await tx
          .insert(supportAgentSkills)
          .values(skills.map((skill) => ({ orgId, userId, skill })))
          .onConflictDoNothing();
      }
    });
    return { success: true, skills };
  }

  listAgentSkills(orgId: string) {
    return this.db.query.supportAgentSkills.findMany({ where: eq(supportAgentSkills.orgId, orgId) });
  }

  async setAgentAvailability(orgId: string, userId: string, isAvailable: boolean) {
    const [row] = await this.db
      .insert(supportAgentAvailability)
      .values({ orgId, userId, isAvailable })
      .onConflictDoUpdate({
        target: [supportAgentAvailability.orgId, supportAgentAvailability.userId],
        set: { isAvailable, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  listAgentAvailability(orgId: string) {
    return this.db.query.supportAgentAvailability.findMany({ where: eq(supportAgentAvailability.orgId, orgId) });
  }

  async addVipClient(orgId: string, clientId: number) {
    await this.db.insert(supportVipClients).values({ orgId, clientId }).onConflictDoNothing();
    return { success: true };
  }

  async removeVipClient(orgId: string, clientId: number) {
    await this.db
      .delete(supportVipClients)
      .where(and(eq(supportVipClients.orgId, orgId), eq(supportVipClients.clientId, clientId)));
    return { success: true };
  }

  listVipClients(orgId: string) {
    return this.db.query.supportVipClients.findMany({ where: eq(supportVipClients.orgId, orgId) });
  }

  async isVipClient(orgId: string, clientId: number | null | undefined): Promise<boolean> {
    if (!clientId) return false;
    const row = await this.db.query.supportVipClients.findFirst({
      where: and(eq(supportVipClients.orgId, orgId), eq(supportVipClients.clientId, clientId)),
      columns: { id: true },
    });
    return Boolean(row);
  }
}
