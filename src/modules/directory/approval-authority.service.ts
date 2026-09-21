import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  hrWorkflowDelegations,
  organizationMembers,
  orgUnits,
  userDelegationPermissions,
  userDelegations,
  users,
} from "../../db/schema";
import { AccessService } from "../access/access.service";
import { EmploymentFactsService } from "./employment-facts.service";
import { ReportingLineService } from "./reporting-line.service";
import {
  APPROVAL_KIND_POLICIES,
  APPROVAL_QUEUE_MEMBER_CAP,
  APPROVAL_RUNGS,
  type ApprovalCandidate,
  type ApprovalDelegation,
  type ApprovalEscalation,
  type ApprovalKindPolicy,
  type ApprovalQueue,
  type ApprovalRequestKind,
  type ApprovalResolveOptions,
  type ApprovalRoute,
  type ApprovalRung,
  type ApprovalRungSkipReason,
  type SkippedApprovalRung,
} from "./approval-authority.types";

interface Person {
  userId: string;
  membershipId: number;
  name: string | null;
  email: string;
}

interface RungAnswer {
  rung: ApprovalRung;
  userId: string;
}

const SKIP_EXPLANATIONS: Record<ApprovalRungSkipReason, string> = {
  "no-manager": "no reporting manager is on record",
  "no-department-head": "the department has no head",
  self: "the employee cannot approve their own request",
  "lacks-permission": "they cannot approve this kind of request",
  "queue-empty": "nobody holds the approving permission",
  "self-reference": "the employee cannot approve their own request",
  "manager-not-in-organization": "the manager is no longer a member",
  "manager-inactive": "the manager's account is deactivated",
  "manager-has-no-employment": "the manager has no employment record",
  "manager-exited": "the manager has exited",
  circular: "the reporting chain loops back on itself",
};

const RUNG_LABELS: Record<ApprovalRung, string> = {
  reporting_manager: "reporting manager",
  managers_manager: "manager's manager",
  department_head: "department head",
  queue: "queue",
};

function displayName(person: Pick<Person, "name" | "email">): string {
  return person.name?.trim() || person.email;
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

@Injectable()
export class ApprovalAuthorityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly employment: EmploymentFactsService,
    private readonly reportingLines: ReportingLineService,
  ) {}

  async resolve(orgId: string, subjectUserId: string, kind: ApprovalRequestKind, options: ApprovalResolveOptions = {}): Promise<ApprovalRoute> {
    const at = options.at ?? new Date();
    const policy: ApprovalKindPolicy = options.permission
      ? { ...APPROVAL_KIND_POLICIES[kind], permission: options.permission }
      : APPROVAL_KIND_POLICIES[kind];
    const firstRung = APPROVAL_RUNGS.indexOf(options.from ?? "reporting_manager");
    const considers = (rung: ApprovalRung): boolean => APPROVAL_RUNGS.indexOf(rung) >= firstRung;
    const skipped: SkippedApprovalRung[] = [];
    const viable: RungAnswer[] = [];

    const subjectFacts = await this.employment.getFacts(orgId, subjectUserId);
    const managerUserId = subjectFacts.managerUserId;

    if (considers("reporting_manager")) {
      if (managerUserId === null) skipped.push({ rung: "reporting_manager", userId: null, reason: "no-manager" });
      else await this.consider(orgId, "reporting_manager", managerUserId, subjectUserId, policy, skipped, viable);
    }

    if (considers("managers_manager")) {
      const managerFacts = managerUserId === null ? null : await this.employment.getFacts(orgId, managerUserId);
      const grandManagerUserId = managerFacts?.managerUserId ?? null;
      if (grandManagerUserId === null) skipped.push({ rung: "managers_manager", userId: null, reason: "no-manager" });
      else await this.consider(orgId, "managers_manager", grandManagerUserId, subjectUserId, policy, skipped, viable);
    }

    if (considers("department_head")) {
      const headUserId = await this.departmentHead(orgId, subjectFacts.departmentId);
      if (headUserId === null) skipped.push({ rung: "department_head", userId: null, reason: "no-department-head" });
      else await this.consider(orgId, "department_head", headUserId, subjectUserId, policy, skipped, viable);
    }

    const queueMembers = (await this.access.membersWithPermission(orgId, policy.permission, { limit: APPROVAL_QUEUE_MEMBER_CAP }))
      .filter((member) => member.userId !== subjectUserId);
    if (queueMembers.length === 0) skipped.push({ rung: "queue", userId: null, reason: "queue-empty" });

    const people = await this.people(orgId, [
      ...viable.map((answer) => answer.userId),
      ...queueMembers.map((member) => member.userId),
    ]);
    const facts = await this.employment.getFactsBatch(orgId, [...people.keys()]);
    const candidateOf = (userId: string): ApprovalCandidate | null => {
      const person = people.get(userId);
      if (!person) return null;
      return { ...person, designation: facts.get(userId)?.designation ?? null };
    };

    const queue: ApprovalQueue | null = queueMembers.length === 0
      ? null
      : {
          permission: policy.permission,
          label: policy.queueLabel,
          memberCount: queueMembers.length,
          members: queueMembers.map((member) => candidateOf(member.userId)).filter((candidate): candidate is ApprovalCandidate => candidate !== null),
        };

    const first = viable[0] ?? null;
    const assignedTo = first ? candidateOf(first.userId) : null;
    const rung: ApprovalRung | null = first ? first.rung : queue ? "queue" : null;

    const delegation = assignedTo ? await this.delegationOf(orgId, assignedTo, policy, at) : null;
    const approver = delegation ? await this.delegateCandidate(orgId, delegation.toUserId) : assignedTo;

    const escalation = this.escalationAfter(rung, viable, candidateOf, queue);
    const dueAt = new Date(at.getTime() + policy.slaHours * 3_600_000).toISOString();

    return {
      kind,
      subjectUserId,
      permission: policy.permission,
      resolvedAt: at.toISOString(),
      rung,
      assignedTo,
      approver: approver ?? assignedTo,
      delegation: approver ? delegation : null,
      queue: rung === "queue" ? queue : null,
      skipped,
      slaHours: policy.slaHours,
      dueAt,
      escalation,
      explanation: this.explain(rung, assignedTo, approver ?? assignedTo, delegation, queue, skipped, policy),
    };
  }

  private async consider(
    orgId: string,
    rung: ApprovalRung,
    candidateUserId: string,
    subjectUserId: string,
    policy: ApprovalKindPolicy,
    skipped: SkippedApprovalRung[],
    viable: RungAnswer[],
  ): Promise<void> {
    if (candidateUserId === subjectUserId) {
      skipped.push({ rung, userId: candidateUserId, reason: "self" });
      return;
    }
    if (viable.some((answer) => answer.userId === candidateUserId)) return;
    const check = await this.reportingLines.checkManager(orgId, candidateUserId);
    if (!check.ok) {
      skipped.push({ rung, userId: candidateUserId, reason: check.reason });
      return;
    }
    if (!(await this.holdsPermission(orgId, candidateUserId, policy.permission))) {
      skipped.push({ rung, userId: candidateUserId, reason: "lacks-permission" });
      return;
    }
    viable.push({ rung, userId: candidateUserId });
  }

  private async departmentHead(orgId: string, departmentId: string | null): Promise<string | null> {
    if (departmentId === null) return null;
    const [row] = await this.db
      .select({ headUserId: organizationMembers.userId })
      .from(orgUnits)
      .innerJoin(organizationMembers, and(eq(organizationMembers.id, orgUnits.headMembershipId), eq(organizationMembers.orgId, orgUnits.orgId)))
      .where(and(eq(orgUnits.id, departmentId), eq(orgUnits.orgId, orgId), isNull(orgUnits.deletedAt)))
      .limit(1);
    return row?.headUserId ?? null;
  }

  private async people(orgId: string, userIds: readonly string[]): Promise<Map<string, Person>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();
    const rows = await this.db
      .select({ userId: users.id, membershipId: organizationMembers.id, name: users.name, email: users.email })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, unique), eq(organizationMembers.status, "ACTIVE")))
      .limit(unique.length);
    return new Map(rows.map((row) => [row.userId, row]));
  }

  private async delegationOf(orgId: string, approver: ApprovalCandidate, policy: ApprovalKindPolicy, at: Date): Promise<ApprovalDelegation | null> {
    const [workflow] = await this.db
      .select({
        id: hrWorkflowDelegations.id,
        delegateUserId: hrWorkflowDelegations.delegateUserId,
        endsAt: hrWorkflowDelegations.endsAt,
        reason: hrWorkflowDelegations.reason,
      })
      .from(hrWorkflowDelegations)
      .where(
        and(
          eq(hrWorkflowDelegations.orgId, orgId),
          eq(hrWorkflowDelegations.delegatorUserId, approver.userId),
          eq(hrWorkflowDelegations.active, true),
          lte(hrWorkflowDelegations.startsAt, at),
          gte(hrWorkflowDelegations.endsAt, at),
          policy.workflowObjectType === null
            ? isNull(hrWorkflowDelegations.objectType)
            : or(isNull(hrWorkflowDelegations.objectType), eq(hrWorkflowDelegations.objectType, policy.workflowObjectType)),
        ),
      )
      .orderBy(desc(hrWorkflowDelegations.objectType), desc(hrWorkflowDelegations.createdAt))
      .limit(1);
    if (workflow && (await this.holdsPermission(orgId, workflow.delegateUserId, policy.permission))) {
      return {
        source: "workflow",
        delegationId: String(workflow.id),
        fromUserId: approver.userId,
        toUserId: workflow.delegateUserId,
        endsAt: workflow.endsAt.toISOString(),
        reason: workflow.reason,
      };
    }
    const [permission] = await this.db
      .select({
        id: userDelegations.id,
        delegateeMembershipId: userDelegations.delegateeMembershipId,
        endsAt: userDelegations.endsAt,
        reason: userDelegations.reason,
        delegateeUserId: organizationMembers.userId,
      })
      .from(userDelegations)
      .innerJoin(
        userDelegationPermissions,
        and(
          eq(userDelegationPermissions.orgId, userDelegations.orgId),
          eq(userDelegationPermissions.delegationId, userDelegations.id),
          eq(userDelegationPermissions.permissionKey, policy.permission),
        ),
      )
      .innerJoin(organizationMembers, and(eq(organizationMembers.id, userDelegations.delegateeMembershipId), eq(organizationMembers.orgId, userDelegations.orgId)))
      .where(
        and(
          eq(userDelegations.orgId, orgId),
          eq(userDelegations.delegatorMembershipId, approver.membershipId),
          eq(userDelegations.status, "ACTIVE"),
          lte(userDelegations.startsAt, at),
          gte(userDelegations.endsAt, at),
        ),
      )
      .orderBy(desc(userDelegations.createdAt))
      .limit(1);
    if (!permission) return null;
    return {
      source: "permission",
      delegationId: permission.id,
      fromUserId: approver.userId,
      toUserId: permission.delegateeUserId,
      endsAt: permission.endsAt.toISOString(),
      reason: permission.reason,
    };
  }

  private async holdsPermission(orgId: string, userId: string, permission: string): Promise<boolean> {
    const scope = (await this.access.resolveUserPermissions(orgId, userId)).get(permission);
    return scope !== undefined && scope !== "none";
  }

  private async delegateCandidate(orgId: string, userId: string): Promise<ApprovalCandidate | null> {
    const people = await this.people(orgId, [userId]);
    const person = people.get(userId);
    if (!person) return null;
    const facts = await this.employment.getFacts(orgId, userId);
    return { ...person, designation: facts.designation };
  }

  private escalationAfter(
    rung: ApprovalRung | null,
    viable: RungAnswer[],
    candidateOf: (userId: string) => ApprovalCandidate | null,
    queue: ApprovalQueue | null,
  ): ApprovalEscalation | null {
    if (rung === null || rung === "queue") return null;
    const next = viable[1];
    if (next) return { rung: next.rung, approver: candidateOf(next.userId), queue: null };
    if (queue) return { rung: "queue", approver: null, queue };
    return null;
  }

  private explain(
    rung: ApprovalRung | null,
    assignedTo: ApprovalCandidate | null,
    approver: ApprovalCandidate | null,
    delegation: ApprovalDelegation | null,
    queue: ApprovalQueue | null,
    skipped: SkippedApprovalRung[],
    policy: ApprovalKindPolicy,
  ): string {
    const chosenIndex = rung === null ? APPROVAL_RUNGS.length : APPROVAL_RUNGS.indexOf(rung);
    const skippedText = skipped
      .filter((entry) => entry.rung !== "queue" && APPROVAL_RUNGS.indexOf(entry.rung) < chosenIndex)
      .map((entry) => `${RUNG_LABELS[entry.rung]}: ${SKIP_EXPLANATIONS[entry.reason]}`)
      .join("; ");
    if (rung === null) {
      return `Nobody can approve this ${policy.label} request — ${skippedText ? `${skippedText}; ` : ""}${SKIP_EXPLANATIONS["queue-empty"]} (${policy.permission}).`;
    }
    if (rung === "queue" && queue) {
      return `Routed to the ${queue.label} (${queue.memberCount} ${queue.memberCount === 1 ? "approver" : "approvers"}) because ${skippedText}.`;
    }
    if (!assignedTo) return `Routed to the ${RUNG_LABELS[rung]}.`;
    const base = `${displayName(assignedTo)} approves as ${RUNG_LABELS[rung]}`;
    const because = skippedText ? ` because ${skippedText}` : "";
    if (delegation && approver && approver.userId !== assignedTo.userId) {
      return `${base}${because}; they are away until ${formatDay(delegation.endsAt)}, so ${displayName(approver)} is acting on their behalf.`;
    }
    return `${base}${because}.`;
  }
}
