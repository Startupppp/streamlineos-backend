import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, isNull } from "drizzle-orm";
import {
  organizationMembers,
  orgUnitMembers,
  orgUnits,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type { HeadcountInput } from "./dto/hr-directory.schemas";

export interface HeadcountGroup {
  label: string;
  count: number;
}

function toTitleCase(str: string): string {
  return str
    .toLowerCase()
    .split(/[\s_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

@Injectable()
export class OrgStructureService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async getDirectory(orgId: string) {
    return this.cache.cached(`hr:directory:${orgId}`, () => this.buildDirectory(orgId), CACHE_TTL.MEDIUM);
  }

  private async buildDirectory(orgId: string) {
    const members = await this.db
      .select({
        id: users.id,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        image: users.image,
        designation: users.designation,
        role: organizationMembers.role,
        phone: users.phone,
        reportingTo: users.reportingTo,
        orgDepartmentId: users.orgDepartmentId,
        employeeId: users.employeeId,
        isActive: users.isActive,
      })
      .from(users)
      .innerJoin(
        organizationMembers,
        and(eq(organizationMembers.userId, users.id), eq(organizationMembers.orgId, orgId)),
      )
      .where(eq(users.isActive, true))
      .limit(1000);

    const orgDepts = await this.db.query.orgUnits.findMany({
      where: and(eq(orgUnits.orgId, orgId), isNull(orgUnits.deletedAt), eq(orgUnits.kind, "DEPARTMENT")),
      columns: { id: true, name: true },
    });

    const orgDeptById = new Map(orgDepts.map((d) => [d.id, d]));

    return members.map((m) => {
      const orgDept = m.orgDepartmentId ? orgDeptById.get(m.orgDepartmentId) : null;
      return {
        id: m.id,
        name: (m.name ?? [m.firstName, m.lastName].filter(Boolean).join(" ")) || m.email,
        firstName: m.firstName,
        lastName: m.lastName,
        email: m.email,
        image: m.image,
        designation: m.designation,
        role: m.role,
        phone: m.phone,
        reportingTo: m.reportingTo,
        employeeId: m.employeeId,
        department: orgDept ? { id: orgDept.id, name: orgDept.name } : null,
      };
    });
  }

  getOrgChart(orgId: string) {
    return this.cache.cached(`hr:org-chart:${orgId}`, () => this.buildOrgChart(orgId), CACHE_TTL.MEDIUM);
  }

  private async buildOrgChart(orgId: string) {
    const [members, orgDeptRows] = await Promise.all([
      this.db.query.organizationMembers.findMany({
        where: eq(organizationMembers.orgId, orgId),
        columns: { userId: true },
        with: {
          user: {
            columns: {
              id: true,
              name: true,
              email: true,
              role: true,
              designation: true,
              image: true,
              orgDepartmentId: true,
              reportingTo: true,
              isActive: true,
            },
          },
        },
        limit: 1000,
      }),
      this.db
        .select({ id: orgUnits.id, name: orgUnits.name })
        .from(orgUnits)
        .where(and(eq(orgUnits.orgId, orgId), isNull(orgUnits.deletedAt), eq(orgUnits.kind, "DEPARTMENT"))),
    ]);

    const orgDeptMap = new Map<string, string>(orgDeptRows.map((d) => [d.id, d.name]));
    const seen = new Set<string>();
    const result: Array<{
      id: string;
      name: string | null;
      email: string;
      role: string;
      designation: string | null;
      image: string | null;
      departmentId: string | null;
      departmentName: string | null;
      reportingTo: string | null;
    }> = [];

    for (const m of members) {
      const u = m.user;
      if (!u || seen.has(u.id) || u.isActive === false) continue;
      seen.add(u.id);
      const orgDeptName = u.orgDepartmentId ? (orgDeptMap.get(u.orgDepartmentId) ?? null) : null;
      result.push({
        id: u.id,
        name: u.name,
        email: u.email,
        role: toTitleCase(u.role ?? "Employee"),
        designation: u.designation,
        image: u.image,
        departmentId: u.orgDepartmentId ?? null,
        departmentName: orgDeptName,
        reportingTo: u.reportingTo,
      });
    }

    return result;
  }

  getHeadcount(orgId: string, query: HeadcountInput) {
    return this.cache.cached(
      `hr:headcount:${orgId}:${query.groupBy}`,
      () => this.buildHeadcount(orgId, query),
      CACHE_TTL.MEDIUM,
    );
  }

  private async buildHeadcount(orgId: string, query: HeadcountInput) {
    const { groupBy } = query;
    let groups: HeadcountGroup[];

    if (groupBy === "department") {
      const rows = await this.db
        .select({
          orgDepartmentId: users.orgDepartmentId,
          count: count(),
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
        .groupBy(users.orgDepartmentId);

      const allOrgDepts = await this.db
        .select({ id: orgUnits.id, name: orgUnits.name })
        .from(orgUnits)
        .where(and(eq(orgUnits.orgId, orgId), isNull(orgUnits.deletedAt), eq(orgUnits.kind, "DEPARTMENT")));
      const orgDeptMap = new Map(allOrgDepts.map((d) => [d.id, d.name]));

      const byLabel = new Map<string, number>();
      for (const r of rows) {
        const label = r.orgDepartmentId
          ? (orgDeptMap.get(r.orgDepartmentId) ?? "Other")
          : "Unassigned";
        byLabel.set(label, (byLabel.get(label) ?? 0) + Number(r.count));
      }
      groups = Array.from(byLabel, ([label, cnt]) => ({ label, count: cnt }));
    } else if (groupBy === "role") {
      const rows = await this.db
        .select({ role: organizationMembers.role, count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
        .groupBy(organizationMembers.role);

      groups = rows.map((r) => ({ label: r.role ?? "Unassigned", count: Number(r.count) }));
    } else {
      const rows = await this.db
        .select({ branchName: orgUnits.name, count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .leftJoin(orgUnits, eq(users.branchId, orgUnits.id))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
        .groupBy(orgUnits.name);

      groups = rows.map((r) => ({
        label: r.branchName ?? "Head Office",
        count: Number(r.count),
      }));
    }

    groups.sort((a, b) => b.count - a.count);
    return groups;
  }

  async getTeam(orgId: string, teamId: string) {
    const [dept, memberships] = await Promise.all([
      this.db.query.orgUnits.findFirst({
        where: and(eq(orgUnits.id, teamId), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "DEPARTMENT")),
      }),
      this.db
        .select({
          id: users.id,
          name: users.name,
          image: users.image,
          designation: users.designation,
          email: users.email,
          role: organizationMembers.role,
        })
        .from(users)
        .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
        .innerJoin(orgUnitMembers, and(eq(orgUnitMembers.userId, users.id), eq(orgUnitMembers.orgUnitId, teamId)))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(users.isActive, true),
          ),
        )
        .limit(500),
    ]);

    if (!dept) throw new NotFoundException("Team not found");

    const managerName = dept.headUserId
      ? (memberships.find((m) => m.id === dept.headUserId)?.name ?? null)
      : null;

    return {
      id: dept.id,
      name: dept.name,
      managerId: dept.headUserId,
      managerName,
      members: memberships,
    };
  }
}
