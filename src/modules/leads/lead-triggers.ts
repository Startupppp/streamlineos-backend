import { eq, and, asc, count, sql } from "drizzle-orm";
import {
  leads,
  leadAssignmentRules,
  assignmentRuleState,
  leadScoringRules,
  crmSla,
  crmOptions,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import type { AssignmentConfig } from "../../db/schema/crm/leads";
import { TerritoryMatchService } from "../crm/territory-match.service";
import { resolveLeadStatusSemantics } from "./lead-status-semantics";

async function advanceRoundRobinState(db: Db, ruleId: number, userIds: string[]): Promise<string> {
  const [state] = await db.select().from(assignmentRuleState).where(eq(assignmentRuleState.ruleId, ruleId));
  const idx = state ? (state.lastAssignedIndex + 1) % userIds.length : 0;
  if (state) {
    await db.update(assignmentRuleState).set({ lastAssignedIndex: idx }).where(eq(assignmentRuleState.ruleId, ruleId));
  } else {
    await db.insert(assignmentRuleState).values({ ruleId, lastAssignedIndex: idx });
  }
  return userIds[idx]!;
}

async function pickWeightedRoundRobin(
  db: Db,
  ruleId: number,
  userIds: string[],
  weights: Record<string, number>,
): Promise<string> {
  const expandedPool: string[] = [];
  for (const uid of userIds) {
    const w = Math.max(1, Math.round(weights[uid] ?? 1));
    for (let i = 0; i < w; i++) expandedPool.push(uid);
  }
  return advanceRoundRobinState(db, ruleId, expandedPool);
}

async function pickLeastLoaded(db: Db, orgId: string, userIds: string[], openKeys: string[]): Promise<string> {
  const rows = await db
    .select({ userId: leads.assignedToId, cnt: count() })
    .from(leads)
    .where(
      and(
        eq(leads.orgId, orgId),
        sql`${leads.assignedToId} = ANY(ARRAY[${sql.join(userIds.map((id) => sql`${id}`), sql`, `)}]::text[])`,
        sql`${leads.status} = ANY(ARRAY[${sql.join(openKeys.map((k) => sql`${k}`), sql`, `)}]::text[])`,
      ),
    )
    .groupBy(leads.assignedToId);

  const loadMap = new Map<string, number>();
  for (const r of rows) {
    if (r.userId) loadMap.set(r.userId, Number(r.cnt));
  }

  let chosen = userIds[0]!;
  let minLoad = loadMap.get(chosen) ?? 0;
  for (const uid of userIds) {
    const load = loadMap.get(uid) ?? 0;
    if (load < minLoad) {
      minLoad = load;
      chosen = uid;
    }
  }
  return chosen;
}

export async function evaluateAssignmentRules(
  db: Db,
  orgId: string,
  leadId: number,
  territoryMatch?: TerritoryMatchService,
): Promise<{ assigned: boolean; userId: string | null; ruleName: string | null }> {
  const rules = await db
    .select()
    .from(leadAssignmentRules)
    .where(and(eq(leadAssignmentRules.orgId, orgId), eq(leadAssignmentRules.isActive, true)))
    .orderBy(asc(leadAssignmentRules.priority));

  if (rules.length === 0) return { assigned: false, userId: null, ruleName: null };

  const [lead] = await db.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));
  if (!lead) return { assigned: false, userId: null, ruleName: null };

  const leadRecord = lead as Record<string, unknown>;

  const statusOptions = await db
    .select()
    .from(crmOptions)
    .where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status")));
  const semantics = resolveLeadStatusSemantics(statusOptions);

  for (const rule of rules) {
    const conditions = rule.conditions as { field: string; operator: string; value: string }[];
    const allMatch = conditions.every((cond) => {
      const fieldVal = String(leadRecord[cond.field] ?? "");
      switch (cond.operator) {
        case "eq": return fieldVal === cond.value;
        case "contains": return fieldVal.toLowerCase().includes(cond.value.toLowerCase());
        case "gt": return Number(fieldVal) > Number(cond.value);
        case "lt": return Number(fieldVal) < Number(cond.value);
        case "in": return cond.value.split(",").map((v: string) => v.trim()).includes(fieldVal);
        default: return false;
      }
    });

    if (!allMatch) continue;

    const config = rule.config as AssignmentConfig | undefined;
    let assignedUserId: string | null = null;

    if (rule.assignmentType === "assign_user" && rule.assignToUserId) {
      assignedUserId = rule.assignToUserId;
    } else if (rule.assignmentType === "round_robin") {
      const userIds = rule.roundRobinUserIds as string[];
      if (userIds.length === 0) continue;
      assignedUserId = await advanceRoundRobinState(db, rule.id, userIds);
    } else if (rule.assignmentType === "weighted_round_robin") {
      const userIds = rule.roundRobinUserIds as string[];
      if (userIds.length === 0) continue;
      const weights = (config?.weights ?? {}) as Record<string, number>;
      assignedUserId = await pickWeightedRoundRobin(db, rule.id, userIds, weights);
    } else if (rule.assignmentType === "least_loaded") {
      const userIds = rule.roundRobinUserIds as string[];
      if (userIds.length === 0) continue;
      assignedUserId = await pickLeastLoaded(db, orgId, userIds, semantics.slaOpenKeys);
    } else if (rule.assignmentType === "territory") {
      if (!territoryMatch) continue;
      const matchResult = await territoryMatch.match(orgId, {
        city: lead.city ?? undefined,
        country: undefined,
        state: undefined,
        industry: undefined,
        companySize: undefined,
        accountType: undefined,
        productKeys: [],
      });
      if (!matchResult) continue;
      const reps = matchResult.assignedReps;
      if (reps.length === 0) continue;
      assignedUserId = await advanceRoundRobinState(db, rule.id, reps.map(String));
    }

    if (assignedUserId) {
      await db
        .update(leads)
        .set({ assignedToId: assignedUserId, assignedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));
      return { assigned: true, userId: assignedUserId, ruleName: rule.name };
    }
  }

  return { assigned: false, userId: null, ruleName: null };
}

function evaluateRule(leadRecord: Record<string, unknown>, rule: { field: string; operator: string; value: string }): boolean {
  const fieldValue = leadRecord[rule.field];
  if (fieldValue === undefined || fieldValue === null) return false;
  const strValue = String(fieldValue);
  switch (rule.operator) {
    case "eq": return strValue === rule.value;
    case "gt": return Number(strValue) > Number(rule.value);
    case "lt": return Number(strValue) < Number(rule.value);
    case "contains": return strValue.toLowerCase().includes(rule.value.toLowerCase());
    case "in": return rule.value.split(",").map((v: string) => v.trim()).includes(strValue);
    default: return false;
  }
}

export interface ScoreResult {
  score: number;
  changed: boolean;
  dimensionBreakdown: Record<string, number>;
}

export async function recalculateLeadScore(
  db: Db,
  orgId: string,
  leadId: number,
): Promise<ScoreResult | null> {
  const rules = await db.select().from(leadScoringRules).where(eq(leadScoringRules.orgId, orgId));
  if (rules.length === 0) return null;

  const [lead] = await db.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));
  if (!lead) return null;

  const leadRecord = lead as Record<string, unknown>;
  const dimensionBreakdown: Record<string, number> = {};
  let total = 0;

  for (const rule of rules) {
    if (!evaluateRule(leadRecord, rule)) continue;
    const dim = rule.dimension ?? "fit";
    dimensionBreakdown[dim] = (dimensionBreakdown[dim] ?? 0) + rule.points;
    total += rule.points;
  }

  const score = Math.max(0, Math.min(100, total));
  const changed = lead.score !== score;

  await db.update(leads).set({ score, updatedAt: new Date() }).where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));

  return { score, changed, dimensionBreakdown };
}

export async function applySlaPolicy(
  db: Db,
  orgId: string,
  leadId: number,
): Promise<{ slaApplied: boolean; deadline?: Date }> {
  const [lead] = await db.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));
  if (!lead) return { slaApplied: false };

  const priorityKey = (lead.priority ?? "WARM").toUpperCase();

  const allPolicies = await db
    .select()
    .from(crmSla)
    .where(and(eq(crmSla.orgId, orgId), sql`${crmSla.appliesTo} IN ('lead', 'both')`));

  const policy = allPolicies.find((p) => {
    const conds = p.conditions as { priorityKeys?: string[] } | null;
    if (conds?.priorityKeys && conds.priorityKeys.length > 0) {
      return conds.priorityKeys.map((k) => k.toUpperCase()).includes(priorityKey);
    }
    return false;
  });

  if (!policy) return { slaApplied: false };

  const deadline = new Date(lead.createdAt);
  deadline.setHours(deadline.getHours() + policy.firstResponseHours);

  await db.update(leads).set({ slaDeadline: deadline, updatedAt: new Date() }).where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));

  return { slaApplied: true, deadline };
}
