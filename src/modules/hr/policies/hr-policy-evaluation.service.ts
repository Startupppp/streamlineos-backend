import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, lte, gte, or } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrPolicies,
  orgUnitMembers,
  orgUnits,
  organizationMembers,
  users,
  roles,
  roleAssignments,
} from "../../../db/schema";
import type { PolicyType } from "./hr-policy-types";

const SCOPE_SPECIFICITY: Record<string, number> = {
  employee: 100,
  team: 80,
  department: 70,
  role: 60,
  job_level: 50,
  employment_type: 40,
  location: 30,
  state: 20,
  country: 10,
  organization: 0,
};

export interface PolicyEvaluationTrace {
  policyId: number;
  policyName: string;
  version: number;
  matchedScopes: Array<{ scopeType: string; scopeValue: string; specificity: number }>;
  maxSpecificity: number;
  priority: number;
}

export interface PolicyEvaluationResult {
  policy: {
    id: number;
    name: string;
    policyType: string;
    version: number;
    status: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    priority: number;
    rules: Record<string, unknown>;
  };
  rules: Record<string, unknown>;
  trace: PolicyEvaluationTrace;
}

interface EmployeeAttributes {
  userId: string;
  departmentId: string | null;
  teamIds: string[];
  roleSlugs: string[];
  designation: string | null;
  employmentType: string | null;
  locationId: string | null;
  countryCode: string | null;
  stateCode: string | null;
  jobLevel: string | null;
}

@Injectable()
export class HrPolicyEvaluationService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async evaluatePolicy(
    orgId: string,
    employeeId: string,
    policyType: PolicyType,
    eventDate: string,
  ): Promise<PolicyEvaluationResult | null> {
    const attrs = await this.resolveEmployeeAttributes(orgId, employeeId);
    const candidates = await this.collectCandidatePolicies(
      orgId,
      policyType,
      eventDate,
    );

    return this.evaluateCandidates(candidates, attrs);
  }

  async evaluatePolicies(
    orgId: string,
    employeeIds: readonly string[],
    policyType: PolicyType,
    eventDate: string,
  ): Promise<Map<string, PolicyEvaluationResult | null>> {
    const uniqueEmployeeIds = [...new Set(employeeIds)];
    if (uniqueEmployeeIds.length === 0) return new Map();

    const [attributes, candidates] = await Promise.all([
      this.resolveEmployeeAttributesBatch(orgId, uniqueEmployeeIds),
      this.collectCandidatePolicies(orgId, policyType, eventDate),
    ]);

    return new Map(
      uniqueEmployeeIds.map((employeeId) => [
        employeeId,
        attributes.has(employeeId)
          ? this.evaluateCandidates(candidates, attributes.get(employeeId)!)
          : null,
      ]),
    );
  }

  private evaluateCandidates(
    candidates: Awaited<ReturnType<typeof this.collectCandidatePolicies>>,
    attrs: EmployeeAttributes,
  ): PolicyEvaluationResult | null {
    if (candidates.length === 0) return null;
    const scored = candidates
      .map((policy) => this.scorePolicy(policy, attrs))
      .filter((s) => s !== null) as Array<{
      policy: (typeof candidates)[number];
      trace: PolicyEvaluationTrace;
    }>;

    if (scored.length === 0) return null;

    scored.sort((a, b) => {
      const specDiff = b.trace.maxSpecificity - a.trace.maxSpecificity;
      if (specDiff !== 0) return specDiff;
      const priDiff = b.trace.priority - a.trace.priority;
      if (priDiff !== 0) return priDiff;
      return b.trace.version - a.trace.version;
    });

    const winner = scored[0];
    return {
      policy: {
        id: winner.policy.id,
        name: winner.policy.name,
        policyType: winner.policy.policyType,
        version: winner.policy.version,
        status: winner.policy.status,
        effectiveFrom: winner.policy.effectiveFrom,
        effectiveTo: winner.policy.effectiveTo ?? null,
        priority: winner.policy.priority,
        rules: winner.policy.rules,
      },
      rules: winner.policy.rules,
      trace: winner.trace,
    };
  }

  private async resolveEmployeeAttributesBatch(
    orgId: string,
    employeeIds: readonly string[],
  ): Promise<Map<string, EmployeeAttributes>> {
    const [members, unitRows, roleRows] = await Promise.all([
      this.db
        .select({
          userId: organizationMembers.userId,
          designation: users.designation,
          locationId: users.branchId,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            inArray(organizationMembers.userId, employeeIds),
          ),
        ),
      this.db
        .select({
          userId: orgUnitMembers.userId,
          orgUnitId: orgUnitMembers.orgUnitId,
          kind: orgUnits.kind,
        })
        .from(orgUnitMembers)
        .innerJoin(
          orgUnits,
          and(
            eq(orgUnits.id, orgUnitMembers.orgUnitId),
            eq(orgUnits.orgId, orgId),
          ),
        )
        .where(
          and(
            eq(orgUnitMembers.orgId, orgId),
            inArray(orgUnitMembers.userId, employeeIds),
            inArray(orgUnits.kind, ["DEPARTMENT", "TEAM"]),
          ),
        ),
      this.db
        .select({ userId: organizationMembers.userId, slug: roles.slug })
        .from(roleAssignments)
        .innerJoin(
          organizationMembers,
          and(
            eq(organizationMembers.id, roleAssignments.organizationMembershipId),
            eq(organizationMembers.orgId, orgId),
          ),
        )
        .innerJoin(
          roles,
          and(eq(roles.id, roleAssignments.roleId), eq(roles.orgId, orgId)),
        )
        .where(
          and(
            eq(roleAssignments.orgId, orgId),
            inArray(organizationMembers.userId, employeeIds),
          ),
        ),
    ]);

    const attributes = new Map<string, EmployeeAttributes>();
    for (const member of members) {
      attributes.set(member.userId, {
        userId: member.userId,
        departmentId: null,
        teamIds: [],
        roleSlugs: [],
        designation: member.designation,
        employmentType: null,
        locationId: member.locationId,
        countryCode: null,
        stateCode: null,
        jobLevel: null,
      });
    }
    for (const unit of unitRows) {
      const attrs = attributes.get(unit.userId);
      if (!attrs) continue;
      if (unit.kind === "DEPARTMENT" && attrs.departmentId === null) {
        attrs.departmentId = unit.orgUnitId;
      } else if (unit.kind === "TEAM") {
        attrs.teamIds.push(unit.orgUnitId);
      }
    }
    for (const role of roleRows) {
      attributes.get(role.userId)?.roleSlugs.push(role.slug);
    }
    return attributes;
  }

  private async resolveEmployeeAttributes(
    orgId: string,
    employeeId: string,
  ): Promise<EmployeeAttributes> {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, employeeId),
      ),
    });

    if (!member) throw new NotFoundException("Employee not found in organisation");

    const [deptMemberships, teamMemberships, roleRows, u] = await Promise.all([
      this.db
        .select({ orgUnitId: orgUnitMembers.orgUnitId })
        .from(orgUnitMembers)
        .innerJoin(orgUnits, eq(orgUnits.id, orgUnitMembers.orgUnitId))
        .where(
          and(
            eq(orgUnitMembers.userId, employeeId),
            eq(orgUnits.orgId, orgId),
            eq(orgUnits.kind, "DEPARTMENT"),
          ),
        )
        .limit(10),
      // A policy scoped to a TEAM matched nothing while this was hardcoded to [], so `scopeMatchesEmployee` scored 0 and the policy was silently discarded
      this.db
        .select({ orgUnitId: orgUnitMembers.orgUnitId })
        .from(orgUnitMembers)
        .innerJoin(orgUnits, eq(orgUnits.id, orgUnitMembers.orgUnitId))
        .where(
          and(
            eq(orgUnitMembers.userId, employeeId),
            eq(orgUnits.orgId, orgId),
            eq(orgUnits.kind, "TEAM"),
          ),
        )
        .limit(10),
      this.db
        .select({ slug: roles.slug })
        .from(roleAssignments)
        .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
        .innerJoin(
          organizationMembers,
          eq(organizationMembers.id, roleAssignments.organizationMembershipId),
        )
        .where(
          and(
            eq(roleAssignments.orgId, orgId),
            eq(organizationMembers.userId, employeeId),
            eq(organizationMembers.orgId, orgId),
          ),
        ),
      this.db.query.users.findFirst({
        where: eq(users.id, employeeId),
      }),
    ]);

    return {
      userId: employeeId,
      departmentId: deptMemberships[0]?.orgUnitId ?? null,
      teamIds: teamMemberships.map((m) => m.orgUnitId),
      roleSlugs: roleRows.map((r) => r.slug),
      designation: u?.designation ?? null,
      employmentType: null,
      locationId: u?.branchId ?? null,
      countryCode: null,
      stateCode: null,
      jobLevel: null,
    };
  }

  private async collectCandidatePolicies(
    orgId: string,
    policyType: PolicyType,
    eventDate: string,
  ) {
    const rows = await this.db.query.hrPolicies.findMany({
      where: and(
        eq(hrPolicies.orgId, orgId),
        eq(hrPolicies.policyType, policyType),
        eq(hrPolicies.status, "active"),
        isNull(hrPolicies.deletedAt),
        lte(hrPolicies.effectiveFrom, eventDate),
        or(isNull(hrPolicies.effectiveTo), gte(hrPolicies.effectiveTo, eventDate)),
      ),
      with: { scopes: true },
    });
    return rows;
  }

  private scorePolicy(
    policy: Awaited<ReturnType<typeof this.collectCandidatePolicies>>[number],
    attrs: EmployeeAttributes,
  ): { policy: typeof policy; trace: PolicyEvaluationTrace } | null {
    const matchedScopes: PolicyEvaluationTrace["matchedScopes"] = [];

    for (const scope of policy.scopes) {
      if (this.scopeMatchesEmployee(scope, attrs)) {
        matchedScopes.push({
          scopeType: scope.scopeType,
          scopeValue: scope.scopeValue,
          specificity: SCOPE_SPECIFICITY[scope.scopeType] ?? 0,
        });
      }
    }

    if (matchedScopes.length === 0) return null;

    const maxSpecificity = Math.max(...matchedScopes.map((s) => s.specificity));

    return {
      policy,
      trace: {
        policyId: policy.id,
        policyName: policy.name,
        version: policy.version,
        matchedScopes,
        maxSpecificity,
        priority: policy.priority,
      },
    };
  }

  private scopeMatchesEmployee(
    scope: { scopeType: string; scopeValue: string },
    attrs: EmployeeAttributes,
  ): boolean {
    switch (scope.scopeType) {
      case "organization":
        return true;
      case "employee":
        return scope.scopeValue === attrs.userId;
      case "department":
        return attrs.departmentId != null && scope.scopeValue === attrs.departmentId;
      case "team":
        return attrs.teamIds.includes(scope.scopeValue);
      case "role":
        return attrs.roleSlugs.includes(scope.scopeValue);
      case "job_level":
        return scope.scopeValue === (attrs.jobLevel ?? "");
      case "employment_type":
        return scope.scopeValue === (attrs.employmentType ?? "");
      case "location":
        return scope.scopeValue === (attrs.locationId ?? "");
      case "country":
        return scope.scopeValue === (attrs.countryCode ?? "");
      case "state":
        return scope.scopeValue === (attrs.stateCode ?? "");
      default:
        return false;
    }
  }
}
