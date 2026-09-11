import { NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { organizationMembers, supportRoutingRules } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import type {
  CreateRoutingRuleInput,
  UpdateRoutingRuleInput,
} from "../dto/support.schemas";
import { resolveAssignmentModeAgent } from "../support-macros-assignment";
import {
  matchesRoutingCondition,
  type RoutableTicket,
  type RoutingOutcome,
} from "../support-macros-routing";

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
 * clients) is read from both sides, so it stays on the service.
 *
 * The candidate filters (`support-macros-assignment.ts`) and the condition
 * matcher (`support-macros-routing.ts`) are their own modules; this file is
 * the rule store and the loop that applies them.
 *
 * A rule's assignee is stored as an organisation membership
 * (`assignee_membership_id`), but the API still speaks user ids on both
 * sides: the input's `assigneeId` is resolved to the caller org's ACTIVE
 * membership on write, and the outcome's `assigneeId` is the member's user id.
 *
 * Plain `db` parameter rather than a deps bag: the routing engine needs
 * nothing else.
 */

export type { RoutableTicket, RoutingOutcome } from "../support-macros-routing";

/** The ACTIVE membership of `userId` in `orgId`, or null — a rule then has no static assignee. */
async function activeMembershipIdFor(db: Db, orgId: string, userId: string): Promise<number | null> {
  const member = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.userId, userId),
      eq(organizationMembers.status, "ACTIVE"),
    ),
    columns: { id: true },
  });
  return member?.id ?? null;
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
      assigneeMembershipId: input.assigneeId
        ? await activeMembershipIdFor(db, orgId, input.assigneeId)
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

export async function updateRoutingRule(
  db: Db,
  orgId: string,
  ruleId: number,
  input: UpdateRoutingRuleInput,
) {
  const { assigneeId, ...rest } = input;
  const [updated] = await db
    .update(supportRoutingRules)
    .set({
      ...rest,
      ...(assigneeId !== undefined
        ? {
            assigneeMembershipId: assigneeId
              ? await activeMembershipIdFor(db, orgId, assigneeId)
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

    const allMatch = conditions.every((condition) => matchesRoutingCondition(ticket, condition));
    if (!allMatch) continue;

    const outcome: RoutingOutcome = {};
    const candidates = Array.isArray(rule.candidateAgentIds) ? rule.candidateAgentIds : [];
    const requiredSkills = Array.isArray(rule.requiredSkills) ? rule.requiredSkills : [];

    if (rule.assignmentMode !== "static" && candidates.length > 0) {
      outcome.assigneeId = await resolveAssignmentModeAgent(db, orgId, rule.assignmentMode, candidates, requiredSkills);
    } else if (rule.assigneeMembershipId) {
      const member = await db.query.organizationMembers.findFirst({
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
