import { eq, and, asc, sql } from "drizzle-orm";
import {
  leads,
  leadAssignmentRules,
  assignmentRuleState,
  leadScoringRules,
  crmSla,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";

export async function evaluateAssignmentRules(
  db: Db,
  orgId: string,
  leadId: number,
): Promise<{ assigned: boolean; userId: string | null; ruleName: string | null }> {
  const rules = await db
    .select()
    .from(leadAssignmentRules)
    .where(
      and(
        eq(leadAssignmentRules.orgId, orgId),
        eq(leadAssignmentRules.isActive, true),
      ),
    )
    .orderBy(asc(leadAssignmentRules.priority));

  if (rules.length === 0) return { assigned: false, userId: null, ruleName: null };

  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));

  if (!lead) return { assigned: false, userId: null, ruleName: null };

  const leadRecord = lead as Record<string, unknown>;

  for (const rule of rules) {
    const conditions = rule.conditions as { field: string; operator: string; value: string }[];
    const allMatch = conditions.every((cond) => {
      const fieldVal = String(leadRecord[cond.field] ?? "");
      switch (cond.operator) {
        case "eq":
          return fieldVal === cond.value;
        case "contains":
          return fieldVal.toLowerCase().includes(cond.value.toLowerCase());
        case "gt":
          return Number(fieldVal) > Number(cond.value);
        case "lt":
          return Number(fieldVal) < Number(cond.value);
        case "in":
          return cond.value.split(",").map((v: string) => v.trim()).includes(fieldVal);
        default:
          return false;
      }
    });

    if (!allMatch) continue;

    let assignedUserId: string | null = null;

    if (rule.assignmentType === "assign_user" && rule.assignToUserId) {
      assignedUserId = rule.assignToUserId;
    } else if (rule.assignmentType === "round_robin") {
      const userIds = rule.roundRobinUserIds as string[];
      if (userIds.length === 0) continue;

      const [state] = await db
        .select()
        .from(assignmentRuleState)
        .where(eq(assignmentRuleState.ruleId, rule.id));

      const idx = state ? (state.lastAssignedIndex + 1) % userIds.length : 0;
      assignedUserId = userIds[idx];

      if (state) {
        await db
          .update(assignmentRuleState)
          .set({ lastAssignedIndex: idx })
          .where(eq(assignmentRuleState.ruleId, rule.id));
      } else {
        await db.insert(assignmentRuleState).values({
          ruleId: rule.id,
          lastAssignedIndex: idx,
        });
      }
    }

    if (assignedUserId) {
      await db
        .update(leads)
        .set({
          assignedToId: assignedUserId,
          assignedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));

      return { assigned: true, userId: assignedUserId, ruleName: rule.name };
    }
  }

  return { assigned: false, userId: null, ruleName: null };
}

export async function recalculateLeadScore(
  db: Db,
  orgId: string,
  leadId: number,
): Promise<number | null> {
  const rules = await db
    .select()
    .from(leadScoringRules)
    .where(eq(leadScoringRules.orgId, orgId));

  if (rules.length === 0) return null;

  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));

  if (!lead) return null;

  let score = 0;
  const leadRecord = lead as Record<string, unknown>;

  for (const rule of rules) {
    const fieldValue = leadRecord[rule.field];
    if (fieldValue === undefined || fieldValue === null) continue;

    const strValue = String(fieldValue);
    let match = false;

    switch (rule.operator) {
      case "eq":
        match = strValue === rule.value;
        break;
      case "gt":
        match = Number(strValue) > Number(rule.value);
        break;
      case "lt":
        match = Number(strValue) < Number(rule.value);
        break;
      case "contains":
        match = strValue.toLowerCase().includes(rule.value.toLowerCase());
        break;
      case "in":
        match = rule.value.split(",").map((v: string) => v.trim()).includes(strValue);
        break;
    }

    if (match) score += rule.points;
  }

  score = Math.max(0, Math.min(100, score));

  await db
    .update(leads)
    .set({ score, updatedAt: new Date() })
    .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));

  return score;
}

export async function applySlaPolicy(
  db: Db,
  orgId: string,
  leadId: number,
): Promise<{ slaApplied: boolean; deadline?: Date }> {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));

  if (!lead) return { slaApplied: false };

  const priorityMap: Record<string, "low" | "medium" | "high" | "urgent"> = {
    COLD: "low",
    WARM: "medium",
    HOT: "high",
  };
  const slaPriority = priorityMap[lead.priority ?? "WARM"] ?? "medium";

  const policies = await db
    .select()
    .from(crmSla)
    .where(
      and(
        eq(crmSla.orgId, orgId),
        eq(crmSla.priority, slaPriority),
        sql`${crmSla.appliesTo} IN ('lead', 'both')`,
      ),
    )
    .limit(1);

  if (policies.length === 0) return { slaApplied: false };

  const policy = policies[0];
  const deadline = new Date(lead.createdAt!);
  deadline.setHours(deadline.getHours() + policy.firstResponseHours);

  await db
    .update(leads)
    .set({ slaDeadline: deadline, updatedAt: new Date() })
    .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));

  return { slaApplied: true, deadline };
}
