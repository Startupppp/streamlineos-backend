import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrWorkflowDelegations } from "../../../db/schema/hr/workflow-engine";
import { users, organizationMembers } from "../../../db/schema/common/auth";
import { orgUnits } from "../../../db/schema/common/organization";
import { hrEmployments, hrPeople } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { livePersonOfUser, primaryEmploymentOfPerson } from "../../directory/employment-query";
import type { HrWorkflowObjectType, ResolvedStep } from "./hr-workflow-engine.types";

@Injectable()
export class HrWorkflowApproverService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly employment: EmploymentFactsService,
  ) {}

  async resolveApprovers(step: ResolvedStep, subjectEmployeeId: string, orgId: string): Promise<string[]> {
    switch (step.approverType) {
      case "named_user":
        return step.approverValue ? [step.approverValue] : [];

      case "direct_manager": {
        const facts = await this.employment.getFacts(orgId, subjectEmployeeId);
        return facts.managerUserId ? [facts.managerUserId] : [];
      }

      case "managers_manager": {
        const facts = await this.employment.getFacts(orgId, subjectEmployeeId);
        if (!facts.managerUserId) return [];
        const managerFacts = await this.employment.getFacts(orgId, facts.managerUserId);
        return managerFacts.managerUserId ? [managerFacts.managerUserId] : [];
      }

      case "department_head": {
        const facts = await this.employment.getFacts(orgId, subjectEmployeeId);
        if (!facts.departmentId) return [];
        const [dept] = await this.db.select({ headUserId: orgUnits.headUserId })
          .from(orgUnits).where(eq(orgUnits.id, facts.departmentId)).limit(1);
        return dept?.headUserId ? [dept.headUserId] : [];
      }

      case "hr_role": {
        const hrApprovers = await this.access.membersWithPermission(orgId, "hr:leaves:approve");
        return hrApprovers.map((m) => m.userId);
      }

      case "finance_role": {
        const financeApprovers = await this.access.membersWithPermission(orgId, "accounting:approvals:decide");
        return financeApprovers.map((m) => m.userId);
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
      if (value !== null && typeof value === "object" && part in (value as Record<string, unknown>)) {
        value = (value as Record<string, unknown>)[part];
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
    actorUserId: string,
    resolvedApprovers: string[],
    _: string,
    objectType: HrWorkflowObjectType,
  ): Promise<string | null> {
    if (resolvedApprovers.includes(actorUserId)) return actorUserId;

    const now = new Date();
    const delegations = await this.db.select()
      .from(hrWorkflowDelegations)
      .where(
        and(
          eq(hrWorkflowDelegations.orgId, orgId),
          eq(hrWorkflowDelegations.delegateUserId, actorUserId),
          eq(hrWorkflowDelegations.active, true),
          lte(hrWorkflowDelegations.startsAt, now),
        ),
      )
      .limit(20);

    const validDelegations = delegations.filter((d) => {
      if (d.endsAt < now) return false;
      if (d.objectType !== null && d.objectType !== objectType) return false;
      return resolvedApprovers.includes(d.delegatorUserId);
    });

    return validDelegations.length > 0 ? actorUserId : null;
  }
}
