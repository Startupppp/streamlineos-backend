import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import {
  hrEmployments,
  hrPeople,
  organizationMembers,
  orgUnitMembers,
  orgUnits,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import type { HeadcountInput, OrgChartQueryInput } from "./dto/hr-directory.schemas";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { livePersonOfUser, primaryEmploymentOfPerson } from "../../directory/employment-query";
import { OrgChartService } from "./org-chart.service";
export type { OrgChartNode, OrgChartPage } from "./org-chart.service";

export interface HeadcountGroup {
  label: string;
  count: number;
}

@Injectable()
export class OrgStructureService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly employment: EmploymentFactsService,
    private readonly orgChart: OrgChartService,
  ) {}

  async getDirectory(orgId: string, actorUserId: string, scope: DataScope) {
    return this.cache.cached(
      `hr:directory:${orgId}:${actorUserId}:${scope}`,
      () => this.buildDirectory(orgId, actorUserId, scope),
      CACHE_TTL.MEDIUM,
    );
  }

  private async buildDirectory(
    orgId: string,
    actorUserId: string,
    scope: DataScope,
  ) {
    const members = await this.db
      .select({
        id: users.id,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        image: users.image,
        role: organizationMembers.role,
        phone: users.phone,
        isActive: users.isActive,
      })
      .from(users)
      .innerJoin(
        organizationMembers,
        and(eq(organizationMembers.userId, users.id), eq(organizationMembers.orgId, orgId)),
      )
      .where(
        and(
          eq(users.isActive, true),
          applyScope(scope, orgId, actorUserId, {
            ownerColumn: organizationMembers.userId,
          }),
        ),
      )
      .limit(1000);

    const memberIds = members.map((m) => m.id);
    const [orgDepts, factsMap] = await Promise.all([
      this.db.query.orgUnits.findMany({
        where: and(eq(orgUnits.orgId, orgId), isNull(orgUnits.deletedAt), eq(orgUnits.kind, "DEPARTMENT")),
        columns: { id: true, name: true },
      }),
      this.employment.getFactsBatch(orgId, memberIds),
    ]);

    const orgDeptById = new Map(orgDepts.map((d) => [d.id, d]));
    const visibleUserIds = new Set(memberIds);

    return members.map((m) => {
      const facts = factsMap.get(m.id);
      const deptId = facts?.departmentId ?? null;
      const orgDept = deptId ? orgDeptById.get(deptId) : null;
      return {
        id: m.id,
        name: (m.name ?? [m.firstName, m.lastName].filter(Boolean).join(" ")) || m.email,
        firstName: m.firstName,
        lastName: m.lastName,
        email: m.email,
        image: m.image,
        designation: facts?.designation ?? null,
        role: m.role,
        phone: m.phone,
        reportingTo:
          facts?.managerUserId && visibleUserIds.has(facts.managerUserId)
            ? facts.managerUserId
            : null,
        employeeId: facts?.employeeNumber ?? null,
        department: orgDept ? { id: orgDept.id, name: orgDept.name } : null,
      };
    });
  }

  getOrgChart(
    orgId: string,
    actorUserId: string,
    scope: DataScope,
    query: OrgChartQueryInput,
  ) {
    return this.orgChart.getOrgChart(orgId, actorUserId, scope, query);
  }

  getHeadcount(orgId: string, query: HeadcountInput) {
    return this.cache.cachedVersioned(
      CACHE_KEYS.hrHeadcountNamespace(orgId),
      `group:${query.groupBy}`,
      () => this.buildHeadcount(orgId, query),
      CACHE_TTL.MEDIUM,
    );
  }

  private async buildHeadcount(orgId: string, query: HeadcountInput) {
    const { groupBy } = query;
    let groups: HeadcountGroup[];

    if (groupBy === "department") {
      const departmentLabel = sql<string>`case
        when ${hrEmployments.departmentId} is null then 'Unassigned'
        when ${orgUnits.id} is null then 'Other'
        else ${orgUnits.name}
      end`;
      const headcountRows = await this.db
        .select({
          label: departmentLabel,
          count: count(),
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .leftJoin(
          orgUnits,
          and(
            eq(hrEmployments.departmentId, orgUnits.id),
            eq(orgUnits.orgId, orgId),
            eq(orgUnits.kind, "DEPARTMENT"),
            isNull(orgUnits.deletedAt),
          ),
        )
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(users.isActive, true),
          ),
        )
        .groupBy(departmentLabel);

      groups = headcountRows.map((headcountRow) => ({
        label: headcountRow.label,
        count: Number(headcountRow.count),
      }));
    } else if (groupBy === "role") {
      const roleHeadcountRows = await this.db
        .select({ role: organizationMembers.role, count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
        .groupBy(organizationMembers.role);

      groups = roleHeadcountRows.map((headcountRow) => ({
        label: headcountRow.role ?? "Unassigned",
        count: Number(headcountRow.count),
      }));
    } else {
      const branchHeadcountRows = await this.db
        .select({ branchName: orgUnits.name, count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .leftJoin(
          orgUnits,
          and(
            eq(hrEmployments.locationId, orgUnits.id),
            eq(orgUnits.orgId, orgId),
            eq(orgUnits.kind, "BRANCH"),
            isNull(orgUnits.deletedAt),
          ),
        )
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
        .groupBy(orgUnits.name);

      groups = branchHeadcountRows.map((headcountRow) => ({
        label: headcountRow.branchName ?? "Head Office",
        count: Number(headcountRow.count),
      }));
    }

    groups.sort(
      (leftGroup, rightGroup) => rightGroup.count - leftGroup.count,
    );
    return groups;
  }

  async getTeam(
    orgId: string,
    actorUserId: string,
    teamId: string,
    scope: DataScope,
  ) {
    const [dept, memberships] = await Promise.all([
      this.db.query.orgUnits.findFirst({
        where: and(eq(orgUnits.id, teamId), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "DEPARTMENT")),
      }),
      this.db
        .select({
          id: users.id,
          name: users.name,
          image: users.image,
          email: users.email,
          role: organizationMembers.role,
        })
        .from(users)
        .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
        .innerJoin(orgUnitMembers, and(eq(orgUnitMembers.userId, users.id), eq(orgUnitMembers.orgUnitId, teamId)))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(orgUnitMembers.orgId, orgId),
            eq(users.isActive, true),
            applyScope(scope, orgId, actorUserId, {
              ownerColumn: organizationMembers.userId,
            }),
          ),
        )
        .limit(500),
    ]);

    if (!dept) throw new NotFoundException("Team not found");

    const factsMap = await this.employment.getFactsBatch(orgId, memberships.map((m) => m.id));

    const visibleManager = dept.headUserId
      ? memberships.find((member) => member.id === dept.headUserId)
      : undefined;

    return {
      id: dept.id,
      name: dept.name,
      managerId: visibleManager?.id ?? null,
      managerName: visibleManager?.name ?? null,
      members: memberships.map((m) => ({
        ...m,
        designation: factsMap.get(m.id)?.designation ?? null,
      })),
    };
  }

}
