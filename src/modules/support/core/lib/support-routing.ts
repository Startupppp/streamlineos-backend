import { NotFoundException } from "@nestjs/common";
import { and, asc, count, eq, inArray, or } from "drizzle-orm";
import {
  supportRoutingRules,
  supportTickets,
  supportAgentSkills,
  supportAgentAvailability,
  type RoutingRuleCondition,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import type {
  CreateRoutingRuleInput,
  UpdateRoutingRuleInput,
} from "../dto/support.schemas";

/**
 * Auto-assignment routing rules: their CRUD, and the engine that evaluates
 * them when a ticket is created.
 *
 * Split out of `SupportMacrosService` because a routing rule and a macro are
 * two unrelated things that happened to share a file. A macro is a canned
 * reply an agent chooses; a routing rule is an org-level policy that runs
 * with no agent present. They share no row, no table and no caller — the
 * ticket-create path calls `applyRoutingRules`, and the compose path calls
 * the macro renderer. Only the agent roster (skills, availability, VIP
 * clients) is read from both sides, so it stays on the service and the
 * candidate filters below read those tables directly.
 *
 * Plain `db` parameter rather than a deps bag: the routing engine needs
 * nothing else.
 */

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

export function listRoutingRules(db: Db, orgId: string) {
  return db.query.supportRoutingRules.findMany({
    where: eq(supportRoutingRules.orgId, orgId),
    orderBy: [asc(supportRoutingRules.sortOrder), asc(supportRoutingRules.id)],
    limit: 100,
  });
}

export async function createRoutingRule(
  db: Db,
  orgId: string,
  userId: string,
  input: CreateRoutingRuleInput,
) {
  const [rule] = await db
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

export async function updateRoutingRule(
  db: Db,
  orgId: string,
  ruleId: number,
  input: UpdateRoutingRuleInput,
) {
  const [updated] = await db
    .update(supportRoutingRules)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(supportRoutingRules.id, ruleId), eq(supportRoutingRules.orgId, orgId)))
    .returning();

  if (!updated) throw new NotFoundException("Routing rule not found");
  return updated;
}

export async function deleteRoutingRule(db: Db, orgId: string, ruleId: number) {
  const [deleted] = await db
    .delete(supportRoutingRules)
    .where(and(eq(supportRoutingRules.id, ruleId), eq(supportRoutingRules.orgId, orgId)))
    .returning();

  if (!deleted) throw new NotFoundException("Routing rule not found");
  return { success: true };
}

export async function applyRoutingRules(
  db: Db,
  orgId: string,
  ticket: RoutableTicket,
): Promise<RoutingOutcome> {
  const rules = await db.query.supportRoutingRules.findMany({
    where: and(eq(supportRoutingRules.orgId, orgId), eq(supportRoutingRules.isEnabled, true)),
    orderBy: [asc(supportRoutingRules.sortOrder), asc(supportRoutingRules.id)],
  });

  for (const rule of rules) {
    const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
    if (conditions.length === 0) continue;

    const allMatch = conditions.every((condition) => matchesCondition(ticket, condition));
    if (!allMatch) continue;

    const outcome: RoutingOutcome = {};
    const candidates = Array.isArray(rule.candidateAgentIds) ? rule.candidateAgentIds : [];
    const requiredSkills = Array.isArray(rule.requiredSkills) ? rule.requiredSkills : [];

    if (rule.assignmentMode !== "static" && candidates.length > 0) {
      outcome.assigneeId = await resolveAssignmentModeAgent(db, orgId, rule.assignmentMode, candidates, requiredSkills);
    } else if (rule.assigneeId) {
      outcome.assigneeId = rule.assigneeId;
    }

    if (rule.setPriority) outcome.setPriority = rule.setPriority;
    return outcome;
  }

  return {};
}

async function loadBalance(db: Db, orgId: string, candidates: string[]): Promise<string> {
  const workloads = await db
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
async function filterBySkills(db: Db, orgId: string, candidates: string[], requiredSkills: string[]): Promise<string[]> {
  if (requiredSkills.length === 0) return candidates;

  const rows = await db
    .select({ userId: supportAgentSkills.userId, skill: supportAgentSkills.skill })
    .from(supportAgentSkills)
    .where(
      and(
        eq(supportAgentSkills.orgId, orgId),
        inArray(supportAgentSkills.userId, candidates),
        inArray(supportAgentSkills.skill, requiredSkills),
      ),
    );

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
async function filterByAvailability(db: Db, orgId: string, candidates: string[]): Promise<string[]> {
  const rows = await db
    .select({ userId: supportAgentAvailability.userId, isAvailable: supportAgentAvailability.isAvailable })
    .from(supportAgentAvailability)
    .where(
      and(
        eq(supportAgentAvailability.orgId, orgId),
        inArray(supportAgentAvailability.userId, candidates),
      ),
    );

  const availabilityByUser = new Map(rows.map((r) => [r.userId, r.isAvailable]));
  const available = candidates.filter((c) => availabilityByUser.get(c) ?? true);
  return available.length > 0 ? available : candidates;
}

async function resolveAssignmentModeAgent(
  db: Db,
  orgId: string,
  mode: string,
  candidates: string[],
  requiredSkills: string[],
): Promise<string> {
  if (mode === "load_balanced") {
    return loadBalance(db, orgId, candidates);
  }

  if (mode === "skill_based") {
    const qualified = await filterBySkills(db, orgId, candidates, requiredSkills);
    return loadBalance(db, orgId, qualified);
  }

  if (mode === "availability_based") {
    const available = await filterByAvailability(db, orgId, candidates);
    return loadBalance(db, orgId, available);
  }

  // round_robin: use total ticket count for the org as a stateless rotating cursor.
  const [totalResult] = await db
    .select({ cnt: count() })
    .from(supportTickets)
    .where(eq(supportTickets.orgId, orgId));
  const cursor = Number(totalResult?.cnt ?? 0) % candidates.length;
  return candidates[cursor];
}

function resolveField(ticket: RoutableTicket, field: string): string | null {
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

function matchesCondition(ticket: RoutableTicket, condition: RoutingRuleCondition): boolean {
  const fieldValue = resolveField(ticket, condition.field);
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
