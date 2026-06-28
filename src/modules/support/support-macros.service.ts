import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, ilike, or } from "drizzle-orm";
import { supportMacros, supportRoutingRules, type RoutingRuleCondition } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type {
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
}

export interface RoutingOutcome {
  assigneeId?: string;
  setPriority?: string;
}

@Injectable()
export class SupportMacrosService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listMacros(orgId: string, query: ListMacrosInput) {
    const conditions = [eq(supportMacros.orgId, orgId)];
    if (query.category) conditions.push(eq(supportMacros.category, query.category));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(ilike(supportMacros.title, term), ilike(supportMacros.body, term));
      if (match) conditions.push(match);
    }

    return this.db.query.supportMacros.findMany({
      where: and(...conditions),
      orderBy: [asc(supportMacros.title)],
      limit: 200,
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
      if (rule.assigneeId) outcome.assigneeId = rule.assigneeId;
      if (rule.setPriority) outcome.setPriority = rule.setPriority;
      return outcome;
    }

    return {};
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
