import { eq, and, asc, count, sql } from "drizzle-orm";
import {
  leadAssignmentRules,
  assignmentRuleState,
  leadScoringRules,
  crmSla,
  crmOptions,
} from "../../db/schema";
import { businessParties, leadPartyMap } from "../../db/schema/party";
import type { Db } from "../../db/drizzle.module";
import { TerritoryMatchService } from "../crm/core/territory-match.service";
import {
  INCLUDE_DELETED,
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadPartyScope,
  loadLeadView,
} from "./lead-party-reader";
import { resolveLeadStatusSemantics } from "./lead-status-semantics";
import { updateMirroredLeads } from "../party/party-legacy-leads";

async function advanceRoundRobinState(db: Db, ruleId: number, userIds: string[]): Promise<string> {
  const [state] = await db
    .insert(assignmentRuleState)
    .values({ ruleId, lastAssignedIndex: 0 })
    .onConflictDoUpdate({
      target: assignmentRuleState.ruleId,
      set: {
        lastAssignedIndex: sql`(${assignmentRuleState.lastAssignedIndex} + 1) % ${userIds.length}`,
      },
    })
    .returning({ lastAssignedIndex: assignmentRuleState.lastAssignedIndex });
  return userIds[state?.lastAssignedIndex ?? 0];
}

function expandWeightedPool(userIds: string[], weights: Record<string, number>): string[] {
  const expandedPool: string[] = [];
  for (const uid of userIds) {
    const w = Math.max(1, Math.round(weights[uid] ?? 1));
    for (let i = 0; i < w; i++) expandedPool.push(uid);
  }
  return expandedPool;
}

async function pickLeastLoaded(db: Db, orgId: string, userIds: string[], openKeys: string[]): Promise<string> {
  const rows = await db
    .select({ userId: LEAD_PARTY_COLUMNS.assignedToId, cnt: count() })
    .from(leadPartyMap)
    .innerJoin(businessParties, LEAD_PARTY_JOIN)
    .where(
      and(
        ...leadPartyScope(orgId, INCLUDE_DELETED),
        sql`${LEAD_PARTY_COLUMNS.assignedToId} = ANY(ARRAY[${sql.join(userIds.map((id) => sql`${id}`), sql`, `)}]::text[])`,
        sql`${LEAD_PARTY_COLUMNS.status} = ANY(ARRAY[${sql.join(openKeys.map((k) => sql`${k}`), sql`, `)}]::text[])`,
      ),
    )
    .groupBy(LEAD_PARTY_COLUMNS.assignedToId);

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

type AssignmentRule = typeof leadAssignmentRules.$inferSelect;

type AssignmentPlan =
  | { readonly kind: "direct"; readonly rule: AssignmentRule; readonly userId: string }
  | { readonly kind: "round_robin"; readonly rule: AssignmentRule; readonly pool: string[] }
  | { readonly kind: "least_loaded"; readonly rule: AssignmentRule; readonly pool: string[] };

function matchesConditions(rule: AssignmentRule, leadRecord: Record<string, unknown>): boolean {
  return (rule.conditions ?? []).every((cond) => {
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
}

function planForRule(rule: AssignmentRule): AssignmentPlan | null {
  if (rule.assignmentType === "assign_user")
    return rule.assignToUserId ? { kind: "direct", rule, userId: rule.assignToUserId } : null;

  const pool = rule.roundRobinUserIds ?? [];
  if (pool.length === 0) return null;
  if (rule.assignmentType === "round_robin") return { kind: "round_robin", rule, pool };
  if (rule.assignmentType === "weighted_round_robin")
    return { kind: "round_robin", rule, pool: expandWeightedPool(pool, rule.config.weights ?? {}) };
  if (rule.assignmentType === "least_loaded") return { kind: "least_loaded", rule, pool };
  return null;
}

async function resolveAssignee(
  db: Db,
  orgId: string,
  plan: AssignmentPlan,
  openKeys: string[],
): Promise<string> {
  switch (plan.kind) {
    case "direct":
      return plan.userId;
    case "least_loaded":
      return pickLeastLoaded(db, orgId, plan.pool, openKeys);
    case "round_robin":
      return advanceRoundRobinState(db, plan.rule.id, plan.pool);
  }
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

  const lead = await loadLeadView(db, orgId, leadId, INCLUDE_DELETED);
  if (!lead) return { assigned: false, userId: null, ruleName: null };

  // A rule's `field` is a column name a tenant chose against `leads`' vocabulary,
  // which is why the seam hands the row back under those names.
  const leadRecord: Record<string, unknown> = { ...lead };

  const statusOptions = await db
    .select()
    .from(crmOptions)
    .where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status")));
  const semantics = resolveLeadStatusSemantics(statusOptions);

  const matched = rules.filter((rule) => matchesConditions(rule, leadRecord));

  let plan: AssignmentPlan | null = null;
  for (const rule of matched) {
    if (rule.assignmentType !== "territory") {
      plan = planForRule(rule);
      if (plan) break;
      continue;
    }
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
    const reps = matchResult?.assignedReps ?? [];
    if (reps.length === 0) continue;
    plan = { kind: "round_robin", rule, pool: reps.map(String) };
    break;
  }

  if (!plan) return { assigned: false, userId: null, ruleName: null };

  const assignedUserId = await resolveAssignee(db, orgId, plan, semantics.slaOpenKeys);
  await updateMirroredLeads(db, orgId, [leadId], {
    assignedToId: assignedUserId,
    assignedAt: new Date(),
    updatedAt: new Date(),
  });
  return { assigned: true, userId: assignedUserId, ruleName: plan.rule.name };
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

  const lead = await loadLeadView(db, orgId, leadId, INCLUDE_DELETED);
  if (!lead) return null;

  const leadRecord: Record<string, unknown> = { ...lead };
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

  await updateMirroredLeads(db, orgId, [leadId], { score, updatedAt: new Date() });

  return { score, changed, dimensionBreakdown };
}

export async function applySlaPolicy(
  db: Db,
  orgId: string,
  leadId: number,
): Promise<{ slaApplied: boolean; deadline?: Date }> {
  const lead = await loadLeadView(db, orgId, leadId, INCLUDE_DELETED);
  if (!lead) return { slaApplied: false };

  const priorityKey = lead.priority.toUpperCase();

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

  await updateMirroredLeads(db, orgId, [leadId], { slaDeadline: deadline, updatedAt: new Date() });

  return { slaApplied: true, deadline };
}
