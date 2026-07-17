import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, inArray } from "drizzle-orm";
import {
  departmentMembers,
  departments,
  organizationMembers,
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
        departmentId: users.departmentId,
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

    const depts = await this.db.query.departments.findMany({
      where: eq(departments.orgId, orgId),
      columns: { id: true, name: true, managerId: true },
    });

    const deptMemberships =
      depts.length > 0
        ? await this.db.query.departmentMembers.findMany({
            where: inArray(
              departmentMembers.departmentId,
              depts.map((d) => d.id),
            ),
            columns: { userId: true, departmentId: true },
          })
        : [];

    const deptById = new Map(depts.map((d) => [d.id, d]));
    const userDeptMap = new Map<string, number>();
    for (const dm of deptMemberships) {
      userDeptMap.set(dm.userId, dm.departmentId);
    }

    return members.map((m) => {
      const deptId = m.departmentId ?? userDeptMap.get(m.id) ?? null;
      const dept = deptId ? deptById.get(deptId) : null;
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
        department: dept ? { id: dept.id, name: dept.name } : null,
      };
    });
  }

  getOrgChart(orgId: string) {
    return this.cache.cached(`hr:org-chart:${orgId}`, () => this.buildOrgChart(orgId), CACHE_TTL.MEDIUM);
  }

  private async buildOrgChart(orgId: string) {
    const [members, deptRows] = await Promise.all([
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
              departmentId: true,
              reportingTo: true,
              isActive: true,
            },
          },
        },
        limit: 1000,
      }),
      this.db
        .select({ id: departments.id, name: departments.name })
        .from(departments)
        .where(eq(departments.orgId, orgId)),
    ]);

    const deptMap = new Map<number, string>(deptRows.map((d) => [d.id, d.name]));
    const seen = new Set<string>();
    const result: Array<{
      id: string;
      name: string | null;
      email: string;
      role: string;
      designation: string | null;
      image: string | null;
      departmentId: number | null;
      departmentName: string | null;
      reportingTo: string | null;
    }> = [];

    for (const m of members) {
      const u = m.user;
      if (!u || seen.has(u.id) || u.isActive === false) continue;
      seen.add(u.id);
      result.push({
        id: u.id,
        name: u.name,
        email: u.email,
        role: toTitleCase(u.role ?? "Employee"),
        designation: u.designation,
        image: u.image,
        departmentId: u.departmentId,
        departmentName: u.departmentId ? (deptMap.get(u.departmentId) ?? null) : null,
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
    let groups: HeadcountGroup[] = [];

    if (groupBy === "department") {
      const rows = await this.db
        .select({ departmentId: users.departmentId, count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
        .groupBy(users.departmentId);

      const allDepts = await this.db
        .select({ id: departments.id, name: departments.name })
        .from(departments)
        .where(eq(departments.orgId, orgId));
      const deptMap = new Map(allDepts.map((d) => [d.id, d.name]));

      groups = rows.map((r) => ({
        label: r.departmentId ? (deptMap.get(r.departmentId) ?? "Other") : "Unassigned",
        count: Number(r.count),
      }));
    } else if (groupBy === "role") {
      const rows = await this.db
        .select({ role: users.role, count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
        .groupBy(users.role);

      groups = rows.map((r) => ({ label: r.role ?? "Unassigned", count: Number(r.count) }));
    } else {
      const rows = await this.db
        .select({ branchId: users.branchId, count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
        .groupBy(users.branchId);

      groups = rows.map((r) => ({
        label: r.branchId ? `Branch ${r.branchId}` : "Head Office",
        count: Number(r.count),
      }));
    }

    groups.sort((a, b) => b.count - a.count);
    return groups;
  }

  async getTeam(orgId: string, teamId: number) {
    const [dept, members] = await Promise.all([
      this.db.query.departments.findFirst({
        where: and(eq(departments.id, teamId), eq(departments.orgId, orgId)),
      }),
      this.db
        .select({
          id: users.id,
          name: users.name,
          image: users.image,
          designation: users.designation,
          email: users.email,
          role: users.role,
        })
        .from(users)
        .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(users.departmentId, teamId),
            eq(users.isActive, true),
          ),
        )
        .limit(500),
    ]);

    if (!dept) throw new NotFoundException("Team not found");

    const managerName = dept.managerId
      ? (members.find((m) => m.id === dept.managerId)?.name ?? null)
      : null;

    return {
      id: dept.id,
      name: dept.name,
      managerId: dept.managerId,
      managerName,
      members,
    };
  }
}
