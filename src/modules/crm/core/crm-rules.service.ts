import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { leadAssignmentRules, leadScoringRules, crmEmailTemplates, leads } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import type {
  AssignmentRuleCreateInput,
  AssignmentRuleUpdateInput,
  EmailTemplateCreateInput,
  EmailTemplateUpdateInput,
  ScoringRuleCreateInput,
  ScoringRuleUpdateInput,
  SampleLeadForPreview,
} from "./dto/rules.schemas";
import { TerritoryMatchService } from "./territory-match.service";

type TraceEntry = { ruleId: number; ruleName: string; matched: boolean; reason: string };

interface PreviewResult {
  matchedRule: { id: number; name: string } | null;
  wouldAssignTo: string | null;
  trace: TraceEntry[];
}

@Injectable()
export class CrmRulesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly territoryMatch: TerritoryMatchService,
  ) {}

  listAssignmentRules(orgId: string) {
    return this.db
      .select()
      .from(leadAssignmentRules)
      .where(eq(leadAssignmentRules.orgId, orgId))
      .orderBy(desc(leadAssignmentRules.priority))
      .limit(100);
  }

  async createAssignmentRule(orgId: string, input: AssignmentRuleCreateInput) {
    const [rule] = await this.db
      .insert(leadAssignmentRules)
      .values({
        orgId,
        name: input.name,
        assignmentType: input.assignmentType,
        assignToUserId: input.assignToUserId ?? null,
        roundRobinUserIds: input.roundRobinUserIds ?? [],
        conditions: input.conditions ?? [],
        priority: input.priority,
        isActive: input.isActive,
        config: input.config ?? {},
        assignmentTypeText: input.assignmentTypeText ?? null,
      })
      .returning();
    return rule;
  }

  updateAssignmentRule(orgId: string, id: number, input: AssignmentRuleUpdateInput) {
    return this.db
      .update(leadAssignmentRules)
      .set({
        ...input,
        config: input.config ?? undefined,
        assignmentTypeText: input.assignmentTypeText ?? undefined,
      })
      .where(and(eq(leadAssignmentRules.id, id), eq(leadAssignmentRules.orgId, orgId)))
      .returning()
      .then((rows) => rows[0]);
  }

  async deleteAssignmentRule(orgId: string, id: number) {
    await this.db
      .delete(leadAssignmentRules)
      .where(and(eq(leadAssignmentRules.id, id), eq(leadAssignmentRules.orgId, orgId)));
    return { success: true };
  }

  async reorderAssignmentRules(orgId: string, ruleIds: number[]) {
    await Promise.all(
      ruleIds.map((id, index) =>
        this.db
          .update(leadAssignmentRules)
          .set({ priority: ruleIds.length - index })
          .where(and(eq(leadAssignmentRules.id, id), eq(leadAssignmentRules.orgId, orgId))),
      ),
    );
    return { success: true };
  }

  async preview(orgId: string, sampleLead: SampleLeadForPreview): Promise<PreviewResult> {
    const rules = await this.db
      .select()
      .from(leadAssignmentRules)
      .where(and(eq(leadAssignmentRules.orgId, orgId), eq(leadAssignmentRules.isActive, true)))
      .orderBy(desc(leadAssignmentRules.priority))
      .limit(100);

    const trace: TraceEntry[] = [];

    for (const rule of rules) {
      const conditionMatch = this.evaluateConditions(rule.conditions ?? [], sampleLead);
      if (!conditionMatch.matched) {
        trace.push({ ruleId: rule.id, ruleName: rule.name, matched: false, reason: conditionMatch.reason });
        continue;
      }

      const effectiveType = rule.assignmentTypeText ?? rule.assignmentType;
      const assignedUserId = await this.resolveAssignment(orgId, rule, effectiveType, sampleLead);

      trace.push({ ruleId: rule.id, ruleName: rule.name, matched: true, reason: `Assigned via ${effectiveType}` });

      return { matchedRule: { id: rule.id, name: rule.name }, wouldAssignTo: assignedUserId, trace };
    }

    return { matchedRule: null, wouldAssignTo: null, trace };
  }

  private evaluateConditions(
    conditions: { field: string; operator: string; value: string }[],
    sample: SampleLeadForPreview,
  ): { matched: boolean; reason: string } {
    for (const cond of conditions) {
      const fieldVal = this.getLeadField(sample, cond.field);

      if (!this.applyOperator(cond.operator, fieldVal, cond.value)) {
        return { matched: false, reason: `Condition failed: ${cond.field} ${cond.operator} ${cond.value}` };
      }
    }
    return { matched: true, reason: "All conditions met" };
  }

  private getLeadField(sample: SampleLeadForPreview, field: string): unknown {
    if (field === "source") return sample.source;
    if (field === "priority") return sample.priority;
    if (field === "score") return sample.score;
    if (field === "language") return sample.language;
    if (field === "city") return sample.city;
    if (field.startsWith("customData.")) {
      const key = field.slice("customData.".length);
      return sample.customData?.[key];
    }
    return undefined;
  }

  private applyOperator(operator: string, fieldVal: unknown, condValue: string): boolean {
    if (fieldVal === undefined || fieldVal === null) return false;

    switch (operator) {
      case "eq":
        return String(fieldVal) === condValue;
      case "in":
        return condValue.split(",").map((v) => v.trim()).includes(String(fieldVal));
      case "gte":
        return Number(fieldVal) >= Number(condValue);
      case "contains":
        return String(fieldVal).toLowerCase().includes(condValue.toLowerCase());
      default:
        return String(fieldVal) === condValue;
    }
  }

  private async resolveAssignment(
    orgId: string,
    rule: typeof leadAssignmentRules.$inferSelect,
    effectiveType: string,
    sampleLead: SampleLeadForPreview,
  ): Promise<string | null> {
    const config = (rule.config ?? {}) as {
      weights?: Record<string, number>;
      leastLoadedWindowDays?: number;
      fallbackUserId?: string;
    };

    if (effectiveType === "assign_user") {
      return rule.assignToUserId ?? null;
    }

    if (effectiveType === "round_robin") {
      const candidates = (rule.roundRobinUserIds ?? []) as string[];
      if (candidates.length === 0) return null;
      return candidates[0] ?? null;
    }

    if (effectiveType === "weighted_round_robin") {
      const weights = config.weights ?? {};
      const entries = Object.entries(weights);
      if (entries.length === 0) {
        const candidates = (rule.roundRobinUserIds ?? []) as string[];
        return candidates[0] ?? null;
      }
      const total = entries.reduce((sum, [, w]) => sum + w, 0);
      let rand = Math.random() * total;
      for (const [userId, weight] of entries) {
        rand -= weight;
        if (rand <= 0) return userId;
      }
      return entries[0]?.[0] ?? null;
    }

    if (effectiveType === "least_loaded") {
      const candidates = (rule.roundRobinUserIds ?? []) as string[];
      if (candidates.length === 0) return null;

      const rows = await this.db
        .select({ assignedToId: leads.assignedToId, cnt: count() })
        .from(leads)
        .where(
          and(
            eq(leads.orgId, orgId),
            inArray(leads.assignedToId, candidates),
            notInArray(leads.status, ["CONVERTED", "LOST"]),
            isNull(leads.deletedAt),
          ),
        )
        .groupBy(leads.assignedToId);

      const counts = new Map<string, number>(rows.map((r) => [r.assignedToId ?? "", Number(r.cnt)]));
      let minCount = Infinity;
      let minUser: string | null = null;

      for (const uid of candidates) {
        const c = counts.get(uid) ?? 0;
        if (c < minCount) {
          minCount = c;
          minUser = uid;
        }
      }

      return minUser;
    }

    if (effectiveType === "territory") {
      const matchResult = await this.territoryMatch.match(orgId, {
        city: sampleLead.city,
      });

      if (!matchResult || matchResult.assignedReps.length === 0) {
        return config.fallbackUserId ?? null;
      }

      const rep = matchResult.assignedReps[0];
      return rep !== undefined ? String(rep) : (config.fallbackUserId ?? null);
    }

    return null;
  }

  listScoringRules(orgId: string) {
    return this.cache.cached(
      `crm:scoring-rules:${orgId}`,
      () =>
        this.db
          .select({
            id: leadScoringRules.id,
            field: leadScoringRules.field,
            operator: leadScoringRules.operator,
            value: leadScoringRules.value,
            points: leadScoringRules.points,
            createdAt: leadScoringRules.createdAt,
          })
          .from(leadScoringRules)
          .where(eq(leadScoringRules.orgId, orgId))
          .orderBy(desc(leadScoringRules.createdAt))
          .limit(100),
      CACHE_TTL.LONG,
    );
  }

  async createScoringRule(orgId: string, input: ScoringRuleCreateInput) {
    const [rule] = await this.db
      .insert(leadScoringRules)
      .values({
        orgId,
        field: input.field,
        operator: input.operator,
        value: input.value,
        points: input.points,
      })
      .returning();
    await this.cache.invalidatePattern(`crm:scoring-rules:${orgId}*`);
    return rule;
  }

  updateScoringRule(orgId: string, id: number, input: ScoringRuleUpdateInput) {
    return this.db
      .update(leadScoringRules)
      .set(input)
      .where(and(eq(leadScoringRules.id, id), eq(leadScoringRules.orgId, orgId)))
      .returning()
      .then((rows) => rows[0]);
  }

  async deleteScoringRule(orgId: string, id: number) {
    await this.db
      .delete(leadScoringRules)
      .where(and(eq(leadScoringRules.id, id), eq(leadScoringRules.orgId, orgId)));
    return { success: true };
  }

  listEmailTemplates(orgId: string) {
    return this.db
      .select()
      .from(crmEmailTemplates)
      .where(eq(crmEmailTemplates.orgId, orgId))
      .orderBy(desc(crmEmailTemplates.createdAt))
      .limit(100);
  }

  async createEmailTemplate(orgId: string, userId: string, input: EmailTemplateCreateInput) {
    const [template] = await this.db
      .insert(crmEmailTemplates)
      .values({
        orgId,
        name: input.name,
        subject: input.subject,
        body: input.body,
        createdBy: userId,
      })
      .returning();
    return template;
  }

  updateEmailTemplate(orgId: string, id: number, input: EmailTemplateUpdateInput) {
    return this.db
      .update(crmEmailTemplates)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(crmEmailTemplates.id, id), eq(crmEmailTemplates.orgId, orgId)))
      .returning()
      .then((rows) => rows[0]);
  }

  async deleteEmailTemplate(orgId: string, id: number) {
    await this.db
      .delete(crmEmailTemplates)
      .where(and(eq(crmEmailTemplates.id, id), eq(crmEmailTemplates.orgId, orgId)));
    return { success: true };
  }
}
