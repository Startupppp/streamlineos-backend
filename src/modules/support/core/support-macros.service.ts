import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import {
  supportMacros,
  supportRoutingRules,
  supportTickets,
  supportAgentSkills,
  supportAgentAvailability,
  supportVipClients,
  users,
  organizations,
  organizationMembers,
} from "../../../db/schema";
import { supportTicketPriorityEnum, supportTicketStatusEnum } from "../../../db/schema/common/enums";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { appUrl } from "../../email/app-url";
import type {
  ApplyMacroInput,
  CreateMacroInput,
  CreateRoutingRuleInput,
  ListMacrosInput,
  UpdateMacroInput,
  UpdateRoutingRuleInput,
} from "./dto/support.schemas";
import { resolveAssignmentModeAgent } from "./support-macros-assignment";
import {
  matchesRoutingCondition,
  type RoutableTicket,
  type RoutingOutcome,
} from "./support-macros-routing";

@Injectable()
export class SupportMacrosService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async resolveActiveMembershipId(orgId: string, userId: string): Promise<number> {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    if (!member) throw new NotFoundException("Active organization member not found");
    return member.id;
  }

  listMacros(orgId: string, _userId: string, membershipId: number | null, query: ListMacrosInput) {
    if (membershipId === null) throw new ForbiddenException("Organization membership required");
    const privateVisible = eq(supportMacros.createdByMembershipId, membershipId);
    const visibility = or(sql`${supportMacros.visibility} != 'private'`, privateVisible) ?? sql`false`;
    const conditions = [
      eq(supportMacros.orgId, orgId),
      visibility,
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

  async createMacro(orgId: string, _userId: string, membershipId: number | null, input: CreateMacroInput) {
    if (membershipId === null) throw new ForbiddenException("Organization membership required");
    const [macro] = await this.db
      .insert(supportMacros)
      .values({
        orgId,
        title: input.title,
        body: input.body,
        category: input.category ?? null,
        visibility: input.visibility,
        actions: input.actions,
        createdByMembershipId: membershipId,
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
    if (membershipId === null) throw new ForbiddenException("Organization membership required");
    const macro = await this.db.query.supportMacros.findFirst({
      where: and(eq(supportMacros.id, macroId), eq(supportMacros.orgId, orgId)),
      columns: { id: true, body: true, visibility: true, createdByMembershipId: true },
    });
    if (!macro) throw new NotFoundException("Macro not found");
    const isCreator = macro.createdByMembershipId === membershipId;
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
    if (membershipId === null) throw new ForbiddenException("Organization membership required");
    const macro = await this.db.query.supportMacros.findFirst({
      where: and(eq(supportMacros.id, macroId), eq(supportMacros.orgId, orgId)),
    });
    if (!macro) throw new NotFoundException("Macro not found");
    const isCreator = macro.createdByMembershipId === membershipId;
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
        columns: { id: true, requesterName: true },
        with: { creatorMembership: { columns: { id: true }, with: { user: { columns: { name: true } } } } },
      }),
      this.db.query.users.findFirst({ where: eq(users.id, userId), columns: { name: true } }),
      this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { name: true } }),
    ]);
    if (!ticket) throw new NotFoundException("Ticket not found");

    const customerName = ticket.requesterName ?? ticket.creatorMembership?.user?.name ?? "there";
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
    return this.db.query.supportRoutingRules.findMany({
      where: eq(supportRoutingRules.orgId, orgId),
      orderBy: [asc(supportRoutingRules.sortOrder), asc(supportRoutingRules.id)],
      limit: 100,
    });
  }

  async createRoutingRule(orgId: string, userId: string, input: CreateRoutingRuleInput) {
    const [rule] = await this.db
      .insert(supportRoutingRules)
      .values({
        orgId,
        name: input.name,
        conditions: input.conditions,
        assigneeMembershipId: input.assigneeId
          ? (await this.db.query.organizationMembers.findFirst({
              where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, input.assigneeId), eq(organizationMembers.status, "ACTIVE")),
              columns: { id: true },
            }))?.id ?? null
          : null,
        setPriority: input.setPriority ?? null,
        assignmentMode: input.assignmentMode,
        candidateAgentIds: input.candidateAgentIds,
        requiredSkills: input.requiredSkills,
        isEnabled: input.isEnabled,
        sortOrder: input.sortOrder,
        createdBy: userId,
      })
      .returning();
    return rule;
  }

  async updateRoutingRule(orgId: string, ruleId: number, input: UpdateRoutingRuleInput) {
    const { assigneeId, ...rest } = input;
    const [updated] = await this.db
      .update(supportRoutingRules)
      .set({
        ...rest,
        ...(assigneeId !== undefined
          ? {
              assigneeMembershipId: assigneeId
                ? (await this.db.query.organizationMembers.findFirst({
                    where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, assigneeId), eq(organizationMembers.status, "ACTIVE")),
                    columns: { id: true },
                  }))?.id ?? null
                : null,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(supportRoutingRules.id, ruleId), eq(supportRoutingRules.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Routing rule not found");
    return updated;
  }

  async deleteRoutingRule(orgId: string, ruleId: number) {
    const [deleted] = await this.db
      .delete(supportRoutingRules)
      .where(and(eq(supportRoutingRules.id, ruleId), eq(supportRoutingRules.orgId, orgId)))
      .returning();

    if (!deleted) throw new NotFoundException("Routing rule not found");
    return { success: true };
  }

  async applyRoutingRules(orgId: string, ticket: RoutableTicket): Promise<RoutingOutcome> {
    const rules = await this.db.query.supportRoutingRules.findMany({
      where: and(eq(supportRoutingRules.orgId, orgId), eq(supportRoutingRules.isEnabled, true)),
      orderBy: [asc(supportRoutingRules.sortOrder), asc(supportRoutingRules.id)],
    });

    for (const rule of rules) {
      const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
      if (conditions.length === 0) continue;

      const allMatch = conditions.every((condition) => matchesRoutingCondition(ticket, condition));
      if (!allMatch) continue;

      const outcome: RoutingOutcome = {};
      const candidates = Array.isArray(rule.candidateAgentIds) ? rule.candidateAgentIds : [];
      const requiredSkills = Array.isArray(rule.requiredSkills) ? rule.requiredSkills : [];

      if (rule.assignmentMode !== "static" && candidates.length > 0) {
        outcome.assigneeId = await resolveAssignmentModeAgent(
          this.db,
          orgId,
          rule.assignmentMode,
          candidates,
          requiredSkills,
        );
      } else if (rule.assigneeMembershipId) {
        const member = await this.db.query.organizationMembers.findFirst({
          where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.id, rule.assigneeMembershipId)),
          columns: { userId: true },
        });
        if (member) outcome.assigneeId = member.userId;
      }

      if (rule.setPriority) outcome.setPriority = rule.setPriority;
      return outcome;
    }

    return {};
  }

  /**
   * Filters candidates down to those who have EVERY skill in requiredSkills.
   * Falls back to the full candidate list (rather than returning nothing) if
   * no candidate qualifies — a misconfigured skill requirement shouldn't
   * leave a ticket unassigned.
   */
  /**
   * Filters candidates down to those currently marked available (no row =
   * available by default). Falls back to the full candidate list if nobody
   * is available — better to assign someone than leave the ticket unassigned.
   */
  async setAgentSkills(orgId: string, userId: string, skills: string[]) {
    const membershipId = await this.resolveActiveMembershipId(orgId, userId);
    await this.db.transaction(async (tx) => {
      await tx
        .delete(supportAgentSkills)
        .where(and(eq(supportAgentSkills.orgId, orgId), eq(supportAgentSkills.userMembershipId, membershipId)));
      if (skills.length > 0) {
        await tx
          .insert(supportAgentSkills)
          .values(skills.map((skill) => ({ orgId, userMembershipId: membershipId, skill })))
          .onConflictDoNothing();
      }
    });
    return { success: true, skills };
  }

  listAgentSkills(orgId: string) {
    return this.db
      .select({
        id: supportAgentSkills.id,
        orgId: supportAgentSkills.orgId,
        userId: organizationMembers.userId,
        userMembershipId: supportAgentSkills.userMembershipId,
        skill: supportAgentSkills.skill,
        createdAt: supportAgentSkills.createdAt,
      })
      .from(supportAgentSkills)
      .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, supportAgentSkills.orgId), eq(organizationMembers.id, supportAgentSkills.userMembershipId)))
      .where(eq(supportAgentSkills.orgId, orgId))
      .orderBy(asc(supportAgentSkills.id))
      .limit(500);
  }

  async setAgentAvailability(orgId: string, userId: string, isAvailable: boolean) {
    const membershipId = await this.resolveActiveMembershipId(orgId, userId);
    const [row] = await this.db
      .insert(supportAgentAvailability)
      .values({ orgId, userMembershipId: membershipId, isAvailable })
      .onConflictDoUpdate({
        target: [supportAgentAvailability.orgId, supportAgentAvailability.userMembershipId],
        set: { isAvailable, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  listAgentAvailability(orgId: string) {
    return this.db
      .select({
        id: supportAgentAvailability.id,
        orgId: supportAgentAvailability.orgId,
        userId: organizationMembers.userId,
        userMembershipId: supportAgentAvailability.userMembershipId,
        isAvailable: supportAgentAvailability.isAvailable,
        updatedAt: supportAgentAvailability.updatedAt,
      })
      .from(supportAgentAvailability)
      .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, supportAgentAvailability.orgId), eq(organizationMembers.id, supportAgentAvailability.userMembershipId)))
      .where(eq(supportAgentAvailability.orgId, orgId))
      .orderBy(asc(supportAgentAvailability.id))
      .limit(500);
  }

  async addVipClient(orgId: string, clientId: number) {
    await this.db.insert(supportVipClients).values({ orgId, clientId }).onConflictDoNothing();
    return { success: true };
  }

  async removeVipClient(orgId: string, clientId: number) {
    const removed = await this.db
      .delete(supportVipClients)
      .where(and(eq(supportVipClients.orgId, orgId), eq(supportVipClients.clientId, clientId)))
      .returning({ clientId: supportVipClients.clientId });
    if (removed.length === 0) throw new NotFoundException("VIP client not found");
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
