import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrWorkflowDelegations } from "../../../db/schema/hr/workflow-engine";
import { users, organizationMembers } from "../../../db/schema/common/auth";
import { hrEmployments, hrPeople } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { livePersonOfUser, primaryEmploymentOfPerson } from "../../directory/employment-query";
import { ApprovalAuthorityService } from "../../directory/approval-authority.service";
import {
  approvalKindOfWorkflowObject,
  HR_WORKFLOW_APPROVE_PERMISSION,
  type ApprovalRoute,
  type ApprovalRung,
} from "../../directory/approval-authority.types";
import type { HrWorkflowObjectType, ResolvedStep, WorkflowStepRouting } from "./hr-workflow-engine.types";
import { acceptedEmployee } from "../shared/employee-acceptance";

const MANAGER_RUNG_BY_STEP_TYPE: Readonly<Record<string, ApprovalRung>> = {
  direct_manager: "reporting_manager",
  managers_manager: "managers_manager",
  department_head: "department_head",
};

export function stepRoutingOf(route: ApprovalRoute): WorkflowStepRouting {
  return {
    rung: route.rung,
    approverUserIds: route.approver ? [route.approver.userId] : (route.queue?.members.map((member) => member.userId) ?? []),
    assignedToUserId: route.assignedTo?.userId ?? null,
    delegation: route.delegation
      ? { fromUserId: route.delegation.fromUserId, toUserId: route.delegation.toUserId, endsAt: route.delegation.endsAt }
      : null,
    explanation: route.explanation,
    dueAt: route.dueAt,
    escalationRung: route.escalation?.rung ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

@Injectable()
export class HrWorkflowApproverService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly employment: EmploymentFactsService,
    private readonly approvals: ApprovalAuthorityService,
  ) {}

  async resolveStepRouting(
    step: ResolvedStep,
    subjectEmployeeId: string,
    orgId: string,
    objectType: HrWorkflowObjectType,
  ): Promise<WorkflowStepRouting | null> {
    const rung = MANAGER_RUNG_BY_STEP_TYPE[step.approverType];
    if (!rung) return null;
    const route = await this.approvals.resolve(orgId, subjectEmployeeId, approvalKindOfWorkflowObject(objectType), {
      permission: HR_WORKFLOW_APPROVE_PERMISSION,
      from: rung,
    });
    return stepRoutingOf(route);
  }

  async resolveApprovers(
    step: ResolvedStep,
    subjectEmployeeId: string,
    orgId: string,
    objectType: HrWorkflowObjectType,
  ): Promise<string[]> {
    const routing = await this.resolveStepRouting(step, subjectEmployeeId, orgId, objectType);
    if (routing) return routing.approverUserIds;
    switch (step.approverType) {
      case "named_user":
        return step.approverValue ? [step.approverValue] : [];

      case "hr_role": {
        const hrApprovers = await this.access.membersWithPermission(orgId, "hr:leaves:approve");
        return this.acceptedOf(orgId, hrApprovers.map((m) => m.userId));
      }

      case "finance_role": {
        const financeApprovers = await this.access.membersWithPermission(orgId, "accounting:approvals:decide");
        return this.acceptedOf(orgId, financeApprovers.map((m) => m.userId));
      }

      case "location_hr": {
        const facts = await this.employment.getFacts(orgId, subjectEmployeeId);
        if (!facts.locationId) return [];
        const hrApprovers = await this.access.membersWithPermission(orgId, "hr:leaves:approve");
        if (hrApprovers.length === 0) return [];
        const branchHr = await this.db
          .select({ id: users.id })
          .from(users)
          .innerJoin(hrPeople, livePersonOfUser(orgId, users.id))
          .innerJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
          .where(and(
            inArray(users.id, hrApprovers.map((m) => m.userId)),
            eq(hrEmployments.locationId, facts.locationId),
            acceptedEmployee(),
          ))
          .limit(10);
        return branchHr.map((u) => u.id);
      }

      case "dynamic_expression": {
        if (!step.approverValue) return [];
        return this.resolveDynamicExpression(step.approverValue, subjectEmployeeId, orgId);
      }

      default:
        return [];
    }
  }

  /**
   * `membersWithPermission` answers on grants alone, so a person an
   * administrator created an hour ago and who has never opened the invitation
   * comes back as an approver (HRMS-E2E-015). They cannot sign in, so the step
   * sits in their name until it escalates. Order is preserved so a pool that
   * loses nobody is byte-identical to what the caller passed in.
   */
  private async acceptedOf(orgId: string, userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const accepted = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, userIds), acceptedEmployee()))
      .limit(userIds.length);
    const allowed = new Set(accepted.map((row) => row.userId));
    return userIds.filter((userId) => allowed.has(userId));
  }

  private async resolveDynamicExpression(expression: string, subjectEmployeeId: string, orgId: string): Promise<string[]> {
    const [[member], facts] = await Promise.all([
      this.db.select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.userId, subjectEmployeeId), eq(organizationMembers.orgId, orgId)))
        .limit(1),
      this.employment.getFacts(orgId, subjectEmployeeId),
    ]);
    if (!member) return [];

    const employee: Record<string, unknown> = {
      id: subjectEmployeeId,
      reportingTo: facts.managerUserId,
      departmentId: facts.departmentId,
      branchId: facts.locationId,
      role: member.role,
    };

    const parts = expression.split(".");
    let value: unknown = employee;
    for (const part of parts.slice(1)) {
      if (isRecord(value) && part in value) {
        value = value[part];
      } else {
        value = undefined;
        break;
      }
    }

    if (typeof value === "string" && value.length > 0) return [value];
    return [];
  }

  async resolveEffectiveActor(
    orgId: string,
    actorMembershipId: number,
    resolvedApprovers: string[],
    _: string,
    objectType: HrWorkflowObjectType,
  ): Promise<string | null> {
    const resolvedApproverMembershipIds = await this.membershipIdsForUsers(orgId, resolvedApprovers);
    if (resolvedApproverMembershipIds.includes(actorMembershipId)) return "authorized";

    const now = new Date();
    const delegations = await this.db.select()
      .from(hrWorkflowDelegations)
      .where(
        and(
          eq(hrWorkflowDelegations.orgId, orgId),
          eq(hrWorkflowDelegations.delegateMembershipId, actorMembershipId),
          eq(hrWorkflowDelegations.active, true),
          lte(hrWorkflowDelegations.startsAt, now),
        ),
      )
      .limit(20);

    const validDelegations = delegations.filter((d) => {
      if (d.endsAt < now) return false;
      if (d.objectType !== null && d.objectType !== objectType) return false;
      return d.delegatorMembershipId != null
        && resolvedApproverMembershipIds.includes(d.delegatorMembershipId);
    });

    return validDelegations.length > 0 ? "authorized" : null;
  }

  private async membershipIdsForUsers(orgId: string, userIds: string[]): Promise<number[]> {
    if (userIds.length === 0) return [];
    const uniqueUserIds = [...new Set(userIds)];
    const members = await this.db
      .select({ membershipId: organizationMembers.id })
      .from(organizationMembers)
      .where(and(
        eq(organizationMembers.orgId, orgId),
        inArray(organizationMembers.userId, uniqueUserIds),
      ))
      .limit(uniqueUserIds.length);
    return members.map((member) => member.membershipId);
  }
}
