import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  type SQL,
  and,
  asc,
  count,
  eq,
  gt,
  ilike,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  organizationMembers,
  orgUnitMembers,
  orgUnits,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import type {
  HeadcountInput,
  OrgChartQueryInput,
} from "./dto/hr-directory.schemas";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import {
  decodeOrgChartCursor,
  encodeOrgChartCursor,
} from "./org-chart-cursor";

export interface HeadcountGroup {
  label: string;
  count: number;
}

export interface OrgChartNode {
  id: string;
  name: string;
  role: string;
  designation: string | null;
  image: string | null;
  departmentId: string | null;
  departmentName: string | null;
  hasDirectReports: boolean;
}

export interface OrgChartPage {
  data: OrgChartNode[];
  pageInfo: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
}

function toTitleCase(str: string): string {
  return str
    .toLowerCase()
    .split(/[\s_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const orgChartChildUsers = alias(users, "org_chart_child_users");
const orgChartChildMembers = alias(
  organizationMembers,
  "org_chart_child_members",
);
const orgChartManagerUsers = alias(users, "org_chart_manager_users");
const orgChartManagerMembers = alias(
  organizationMembers,
  "org_chart_manager_members",
);

function escapeLikeValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

@Injectable()
export class OrgStructureService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
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
      .where(
        and(
          eq(users.isActive, true),
          applyScope(scope, orgId, actorUserId, {
            ownerColumn: organizationMembers.userId,
          }),
        ),
      )
      .limit(1000);

    const orgDepts = await this.db.query.orgUnits.findMany({
      where: and(eq(orgUnits.orgId, orgId), isNull(orgUnits.deletedAt), eq(orgUnits.kind, "DEPARTMENT")),
      columns: { id: true, name: true },
    });

    const orgDeptById = new Map(orgDepts.map((d) => [d.id, d]));
    const visibleUserIds = new Set(members.map((member) => member.id));

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
        reportingTo:
          m.reportingTo && visibleUserIds.has(m.reportingTo)
            ? m.reportingTo
            : null,
        employeeId: m.employeeId,
        department: orgDept ? { id: orgDept.id, name: orgDept.name } : null,
      };
    });
  }

  async getOrgChart(
    orgId: string,
    actorUserId: string,
    scope: DataScope,
    query: OrgChartQueryInput,
  ): Promise<OrgChartPage> {
    const cursor = query.cursor
      ? decodeOrgChartCursor(query.cursor)
      : undefined;
    const displayName = sql<string>`coalesce(
      nullif(trim(${users.name}), ''),
      nullif(trim(concat_ws(' ', ${users.firstName}, ${users.lastName})), ''),
      ${users.email}
    )`;
    const normalizedName = sql<string>`lower(${displayName})`;
    const visibleScope = applyScope(scope, orgId, actorUserId, {
      ownerColumn: organizationMembers.userId,
    });
    const visibleManager = sql<boolean>`exists (
      select 1
      from ${orgChartManagerMembers}
      inner join ${orgChartManagerUsers}
        on ${eq(orgChartManagerUsers.id, orgChartManagerMembers.userId)}
      where ${and(
        eq(orgChartManagerMembers.orgId, orgId),
        eq(orgChartManagerMembers.status, "ACTIVE"),
        eq(orgChartManagerUsers.id, users.reportingTo),
        eq(orgChartManagerUsers.isActive, true),
        applyScope(scope, orgId, actorUserId, {
          ownerColumn: orgChartManagerMembers.userId,
        }),
      )}
    )`;
    const hasDirectReports = sql<boolean>`exists (
      select 1
      from ${orgChartChildMembers}
      inner join ${orgChartChildUsers}
        on ${eq(orgChartChildUsers.id, orgChartChildMembers.userId)}
      where ${and(
        eq(orgChartChildMembers.orgId, orgId),
        eq(orgChartChildMembers.status, "ACTIVE"),
        eq(orgChartChildUsers.reportingTo, users.id),
        eq(orgChartChildUsers.isActive, true),
        applyScope(scope, orgId, actorUserId, {
          ownerColumn: orgChartChildMembers.userId,
        }),
      )}
    )`;

    const conditions: SQL[] = [
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.status, "ACTIVE"),
      eq(users.isActive, true),
      visibleScope,
    ];

    if (query.parentId) {
      const visibleParent = sql<boolean>`exists (
        select 1
        from ${orgChartManagerMembers}
        inner join ${orgChartManagerUsers}
          on ${eq(orgChartManagerUsers.id, orgChartManagerMembers.userId)}
        where ${and(
          eq(orgChartManagerMembers.orgId, orgId),
          eq(orgChartManagerMembers.status, "ACTIVE"),
          eq(orgChartManagerUsers.id, query.parentId),
          eq(orgChartManagerUsers.isActive, true),
          applyScope(scope, orgId, actorUserId, {
            ownerColumn: orgChartManagerMembers.userId,
          }),
        )}
      )`;
      conditions.push(eq(users.reportingTo, query.parentId), visibleParent);
    } else if (query.search) {
      const pattern = `%${escapeLikeValue(query.search)}%`;
      conditions.push(
        or(
          ilike(users.name, pattern),
          ilike(users.firstName, pattern),
          ilike(users.lastName, pattern),
          ilike(users.designation, pattern),
          ilike(orgUnits.name, pattern),
        )!,
      );
    } else {
      conditions.push(
        or(isNull(users.reportingTo), sql<boolean>`not ${visibleManager}`)!,
      );
    }

    if (cursor) {
      conditions.push(
        or(
          gt(normalizedName, cursor.name),
          and(
            eq(normalizedName, cursor.name),
            gt(users.id, cursor.employeeUserId),
          ),
        )!,
      );
    }

    const rows = await this.db
      .select({
        id: users.id,
        cursorName: normalizedName,
        name: displayName,
        role: organizationMembers.role,
        designation: users.designation,
        image: users.image,
        departmentId: orgUnits.id,
        departmentName: orgUnits.name,
        hasDirectReports,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(
        orgUnits,
        and(
          eq(users.orgDepartmentId, orgUnits.id),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "DEPARTMENT"),
          isNull(orgUnits.deletedAt),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(normalizedName), asc(users.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const pageRows = rows.slice(0, query.limit);
    const lastRow = pageRows.at(-1);

    return {
      data: pageRows.map((row) => ({
        id: row.id,
        name: row.name,
        role: toTitleCase(row.role ?? "Employee"),
        designation: row.designation,
        image: row.image,
        departmentId: row.departmentId,
        departmentName: row.departmentName,
        hasDirectReports: row.hasDirectReports,
      })),
      pageInfo: {
        limit: query.limit,
        hasMore,
        nextCursor:
          hasMore && lastRow
            ? encodeOrgChartCursor({
                name: lastRow.cursorName,
                employeeUserId: lastRow.id,
              })
            : null,
      },
    };
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
        when ${users.orgDepartmentId} is null then 'Unassigned'
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
        .leftJoin(
          orgUnits,
          and(
            eq(users.orgDepartmentId, orgUnits.id),
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
        .leftJoin(
          orgUnits,
          and(
            eq(users.branchId, orgUnits.id),
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

    const visibleManager = dept.headUserId
      ? memberships.find((member) => member.id === dept.headUserId)
      : undefined;

    return {
      id: dept.id,
      name: dept.name,
      managerId: visibleManager?.id ?? null,
      managerName: visibleManager?.name ?? null,
      members: memberships,
    };
  }
}
