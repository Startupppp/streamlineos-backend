import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  supportMacros,
  supportRoutingRules,
  supportTickets,
  supportAgentSkills,
  supportAgentAvailability,
  supportVipClients,
  users,
  organizations,
  type RoutingRuleCondition,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { appUrl } from "../email/app-url";
import type {
  ApplyMacroInput,
  CreateMacroInput,
  CreateRoutingRuleInput,
  ListMacrosInput,
  UpdateMacroInput,
  UpdateRoutingRuleInput,
} from "./dto/support.schemas";

export interface RoutableTicket {
  title?: string | null;
  category?: string | null;
  description?: string | null;
  priority?: string | null;
  isVip?: boolean;
}

export interface RoutingOutcome {
  assigneeId?: string;
  setPriority?: string;
}

@Injectable()
export class SupportMacrosService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listMacros(orgId: string, userId: string, query: ListMacrosInput) {
    const conditions = [
      eq(supportMacros.orgId, orgId),
      or(sql`${supportMacros.visibility} != 'private'`, eq(supportMacros.createdBy, userId))!,
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

  async createMacro(orgId: string, userId: string, input: CreateMacroInput) {
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
  async previewMacro(orgId: string, macroId: number, userId: string, ticketId: number): Promise<{ body: string }> {
    const macro = await this.db.query.supportMacros.findFirst({
      where: and(eq(supportMacros.id, macroId), eq(supportMacros.orgId, orgId)),
      columns: { id: true, body: true, visibility: true, createdBy: true },
    });
    if (!macro) throw new NotFoundException("Macro not found");
    if (macro.visibility === "private" && macro.createdBy !== userId) {
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
  async applyMacro(orgId: string, macroId: number, userId: string, input: ApplyMacroInput) {
    const macro = await this.db.query.supportMacros.findFirst({
      where: and(eq(supportMacros.id, macroId), eq(supportMacros.orgId, orgId)),
    });
    if (!macro) throw new NotFoundException("Macro not found");
    if (macro.visibility === "private" && macro.createdBy !== userId) {
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
      .where(eq(supportMacros.id, macroId));

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
      "portal.link": `${appUrl}/support/portal/tickets/${ticket.id}`,
    };

    return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => variables[key] ?? match);
  }

  listRoutingRules(orgId: string) {
    return this.db.query.supportRoutingRules.findMany({
      where: eq(supportRoutingRules.orgId, orgId),
      orderBy: [asc(supportRoutingRules.sortOrder), asc(supportRoutingRules.id)],
      limit: 200,
    });
  }

  async createRoutingRule(orgId: string, userId: string, input: CreateRoutingRuleInput) {
    const [rule] = await this.db
      .insert(supportRoutingRules)
      .values({
        orgId,
        name: input.name,
        conditions: input.conditions,
        assigneeId: input.assigneeId ?? null,
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
    const [updated] = await this.db
      .update(supportRoutingRules)
      .set({ ...input, updatedAt: new Date() })
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

      const allMatch = conditions.every((condition) => this.matchesCondition(ticket, condition));
      if (!allMatch) continue;

      const outcome: RoutingOutcome = {};
      const candidates = Array.isArray(rule.candidateAgentIds) ? rule.candidateAgentIds : [];
      const requiredSkills = Array.isArray(rule.requiredSkills) ? rule.requiredSkills : [];

      if (rule.assignmentMode !== "static" && candidates.length > 0) {
        outcome.assigneeId = await this.resolveAssignmentModeAgent(orgId, rule.assignmentMode, candidates, requiredSkills);
      } else if (rule.assigneeId) {
        outcome.assigneeId = rule.assigneeId;
      }

      if (rule.setPriority) outcome.setPriority = rule.setPriority;
      return outcome;
    }

    return {};
  }

  private async loadBalance(orgId: string, candidates: string[]): Promise<string> {
    const workloads = await this.db
      .select({ assigneeId: supportTickets.assigneeId, cnt: count() })
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.orgId, orgId),
          inArray(supportTickets.assigneeId, candidates),
          or(eq(supportTickets.status, "OPEN"), eq(supportTickets.status, "IN_PROGRESS")),
        ),
      )
      .groupBy(supportTickets.assigneeId);

    const workloadMap = new Map(workloads.map((w) => [w.assigneeId, Number(w.cnt)]));
    return candidates.reduce((least, candidate) =>
      (workloadMap.get(candidate) ?? 0) < (workloadMap.get(least) ?? 0) ? candidate : least,
    );
  }

  /**
   * Filters candidates down to those who have EVERY skill in requiredSkills.
   * Falls back to the full candidate list (rather than returning nothing) if
   * no candidate qualifies — a misconfigured skill requirement shouldn't
   * leave a ticket unassigned.
   */
  private async filterBySkills(candidates: string[], requiredSkills: string[]): Promise<string[]> {
    if (requiredSkills.length === 0) return candidates;

    const rows = await this.db
      .select({ userId: supportAgentSkills.userId, skill: supportAgentSkills.skill })
      .from(supportAgentSkills)
      .where(and(inArray(supportAgentSkills.userId, candidates), inArray(supportAgentSkills.skill, requiredSkills)));

    const skillsByUser = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = skillsByUser.get(row.userId) ?? new Set<string>();
      set.add(row.skill);
      skillsByUser.set(row.userId, set);
    }

    const qualified = candidates.filter((c) => requiredSkills.every((skill) => skillsByUser.get(c)?.has(skill)));
    return qualified.length > 0 ? qualified : candidates;
  }

  /**
   * Filters candidates down to those currently marked available (no row =
   * available by default). Falls back to the full candidate list if nobody
   * is available — better to assign someone than leave the ticket unassigned.
   */
  private async filterByAvailability(candidates: string[]): Promise<string[]> {
    const rows = await this.db
      .select({ userId: supportAgentAvailability.userId, isAvailable: supportAgentAvailability.isAvailable })
      .from(supportAgentAvailability)
      .where(inArray(supportAgentAvailability.userId, candidates));

    const availabilityByUser = new Map(rows.map((r) => [r.userId, r.isAvailable]));
    const available = candidates.filter((c) => availabilityByUser.get(c) ?? true);
    return available.length > 0 ? available : candidates;
  }

  private async resolveAssignmentModeAgent(
    orgId: string,
    mode: string,
    candidates: string[],
    requiredSkills: string[],
  ): Promise<string> {
    if (mode === "load_balanced") {
      return this.loadBalance(orgId, candidates);
    }

    if (mode === "skill_based") {
      const qualified = await this.filterBySkills(candidates, requiredSkills);
      return this.loadBalance(orgId, qualified);
    }

    if (mode === "availability_based") {
      const available = await this.filterByAvailability(candidates);
      return this.loadBalance(orgId, available);
    }

    // round_robin: use total ticket count for the org as a stateless rotating cursor.
    const [totalResult] = await this.db
      .select({ cnt: count() })
      .from(supportTickets)
      .where(eq(supportTickets.orgId, orgId));
    const cursor = Number(totalResult?.cnt ?? 0) % candidates.length;
    return candidates[cursor];
  }

  async setAgentSkills(orgId: string, userId: string, skills: string[]) {
    await this.db.delete(supportAgentSkills).where(eq(supportAgentSkills.userId, userId));
    if (skills.length > 0) {
      await this.db
        .insert(supportAgentSkills)
        .values(skills.map((skill) => ({ orgId, userId, skill })))
        .onConflictDoNothing();
    }
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
        target: supportAgentAvailability.userId,
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

  private resolveField(ticket: RoutableTicket, field: string): string | null {
    switch (field) {
      case "title":
      case "subject":
        return ticket.title ?? null;
      case "category":
        return ticket.category ?? null;
      case "description":
        return ticket.description ?? null;
      case "priority":
        return ticket.priority ?? null;
      case "isVip":
        return ticket.isVip ? "true" : "false";
      default:
        return null;
    }
  }

  private matchesCondition(ticket: RoutableTicket, condition: RoutingRuleCondition): boolean {
    const fieldValue = this.resolveField(ticket, condition.field);
    const actual = (fieldValue ?? "").toLowerCase();
    const expected = (condition.value ?? "").toLowerCase();

    switch (condition.op) {
      case "eq":
        return actual === expected;
      case "neq":
        return actual !== expected;
      case "contains":
        return actual.includes(expected);
      default:
        return false;
    }
  }
}
