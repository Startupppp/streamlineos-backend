import { Inject, Injectable } from "@nestjs/common";
import { type SQL, and, asc, eq, gt, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import {
  hrEmployments,
  hrPeople,
  organizationMembers,
  orgUnits,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { OrgChartQueryInput } from "./dto/hr-directory.schemas";
import type { ScopedRead } from "../../access/scoped-read";
import { decodeOrgChartCursor, encodeOrgChartCursor } from "./org-chart-cursor";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { livePersonOfUser, primaryEmploymentOfPerson } from "../../directory/employment-query";
import {
  type OrgChartNode,
  type OrgChartPage,
  orgChartChildUsers,
  orgChartChildMembers,
  orgChartManagerUsers,
  orgChartManagerMembers,
  rlVis,
  rlVisEmpEmp,
  rlVisEmpPpl,
  rlVisMgrEmp,
  rlVisMgrPpl,
  rlChild,
  rlChildMgrEmp,
  rlChildMgrPpl,
  rlChildEmpEmp,
  rlChildEmpPpl,
  toTitleCase,
  escapeLikeValue,
} from "./org-chart-helpers";

export type { OrgChartPage };

@Injectable()
export class OrgChartService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly employment: EmploymentFactsService,
  ) {}

  async getOrgChart(
    read: ScopedRead,
    query: OrgChartQueryInput,
  ): Promise<OrgChartPage> {
    const orgId = read.orgId;
    const cursor = query.cursor
      ? decodeOrgChartCursor(query.cursor)
      : undefined;
    const displayName = sql<string>`coalesce(
      nullif(trim(${users.name}), ''),
      nullif(trim(concat_ws(' ', ${users.firstName}, ${users.lastName})), ''),
      ${users.email}
    )`;
    const normalizedName = sql<string>`lower(${displayName})`;
    const visibleScope = read.compose(
      {
        tenant: organizationMembers.orgId,
        scope: { columns: { ownerColumn: organizationMembers.userId } },
      },
      ({ sql: where }) => where,
      () => sql<boolean>`false`,
    );
    const managerVisibleScope = read.compose(
      {
        tenant: orgChartManagerMembers.orgId,
        scope: { columns: { ownerColumn: orgChartManagerMembers.userId } },
        and: [eq(orgChartManagerMembers.status, "ACTIVE")],
      },
      ({ sql: where }) => where,
      () => sql<boolean>`false`,
    );
    const childVisibleScope = read.compose(
      {
        tenant: orgChartChildMembers.orgId,
        scope: { columns: { ownerColumn: orgChartChildMembers.userId } },
        and: [eq(orgChartChildMembers.status, "ACTIVE")],
      },
      ({ sql: where }) => where,
      () => sql<boolean>`false`,
    );
    const visibleManager = sql<boolean>`exists (
      select 1
      from ${rlVis}
      inner join ${rlVisEmpEmp}
        on ${eq(rlVisEmpEmp.id, rlVis.employmentId)}
        and ${eq(rlVisEmpEmp.orgId, orgId)}
        and ${eq(rlVisEmpEmp.isPrimary, true)}
        and ${isNull(rlVisEmpEmp.deletedAt)}
      inner join ${rlVisEmpPpl}
        on ${eq(rlVisEmpPpl.id, rlVisEmpEmp.personId)}
        and ${eq(rlVisEmpPpl.orgId, orgId)}
        and ${isNull(rlVisEmpPpl.deletedAt)}
      inner join ${rlVisMgrEmp}
        on ${eq(rlVisMgrEmp.id, rlVis.managerEmploymentId)}
        and ${eq(rlVisMgrEmp.orgId, orgId)}
        and ${eq(rlVisMgrEmp.isPrimary, true)}
        and ${isNull(rlVisMgrEmp.deletedAt)}
      inner join ${rlVisMgrPpl}
        on ${eq(rlVisMgrPpl.id, rlVisMgrEmp.personId)}
        and ${eq(rlVisMgrPpl.orgId, orgId)}
        and ${isNull(rlVisMgrPpl.deletedAt)}
      inner join ${orgChartManagerMembers}
        on ${eq(orgChartManagerMembers.userId, rlVisMgrPpl.userId)}
      inner join ${orgChartManagerUsers}
        on ${eq(orgChartManagerUsers.id, rlVisMgrPpl.userId)}
      where ${and(
        eq(rlVis.orgId, orgId),
        eq(rlVisEmpPpl.userId, users.id),
        sql`${rlVis.effectiveFrom} <= CURRENT_DATE`,
        sql`${rlVis.effectiveTo} >= CURRENT_DATE`,
        eq(orgChartManagerUsers.isActive, true),
        managerVisibleScope,
      )}
    )`;
    const hasDirectReports = sql<boolean>`exists (
      select 1
      from ${rlChild}
      inner join ${rlChildMgrEmp}
        on ${eq(rlChildMgrEmp.id, rlChild.managerEmploymentId)}
        and ${eq(rlChildMgrEmp.orgId, orgId)}
        and ${eq(rlChildMgrEmp.isPrimary, true)}
        and ${isNull(rlChildMgrEmp.deletedAt)}
      inner join ${rlChildMgrPpl}
        on ${eq(rlChildMgrPpl.id, rlChildMgrEmp.personId)}
        and ${eq(rlChildMgrPpl.orgId, orgId)}
        and ${isNull(rlChildMgrPpl.deletedAt)}
      inner join ${rlChildEmpEmp}
        on ${eq(rlChildEmpEmp.id, rlChild.employmentId)}
        and ${eq(rlChildEmpEmp.orgId, orgId)}
        and ${eq(rlChildEmpEmp.isPrimary, true)}
        and ${isNull(rlChildEmpEmp.deletedAt)}
      inner join ${rlChildEmpPpl}
        on ${eq(rlChildEmpPpl.id, rlChildEmpEmp.personId)}
        and ${eq(rlChildEmpPpl.orgId, orgId)}
        and ${isNull(rlChildEmpPpl.deletedAt)}
      inner join ${orgChartChildMembers}
        on ${eq(orgChartChildMembers.userId, rlChildEmpPpl.userId)}
      inner join ${orgChartChildUsers}
        on ${eq(orgChartChildUsers.id, rlChildEmpPpl.userId)}
      where ${and(
        eq(rlChild.orgId, orgId),
        eq(rlChildMgrPpl.userId, users.id),
        sql`${rlChild.effectiveFrom} <= CURRENT_DATE`,
        sql`${rlChild.effectiveTo} >= CURRENT_DATE`,
        eq(orgChartChildUsers.isActive, true),
        childVisibleScope,
      )}
    )`;

    const conditions: SQL[] = [
      eq(organizationMembers.status, "ACTIVE"),
      eq(users.isActive, true),
      visibleScope,
    ];

    if (query.parentId) {
      const parentVisibleScope = read.compose(
        {
          tenant: orgChartManagerMembers.orgId,
          scope: { columns: { ownerColumn: orgChartManagerMembers.userId } },
          and: [eq(orgChartManagerMembers.status, "ACTIVE")],
        },
        ({ sql: where }) => where,
        () => sql<boolean>`false`,
      );
      const visibleParent = sql<boolean>`exists (
        select 1
        from ${orgChartManagerMembers}
        inner join ${orgChartManagerUsers}
          on ${eq(orgChartManagerUsers.id, orgChartManagerMembers.userId)}
        where ${and(
          eq(orgChartManagerUsers.id, query.parentId),
          eq(orgChartManagerUsers.isActive, true),
          parentVisibleScope,
        )}
      )`;
      const directReportIds = await this.employment.getDirectReportUserIds(orgId, query.parentId);
      conditions.push(
        directReportIds.length > 0
          ? inArray(organizationMembers.userId, directReportIds)
          : sql<boolean>`FALSE`,
        visibleParent,
      );
    } else if (query.search) {
      const pattern = `%${escapeLikeValue(query.search)}%`;
      conditions.push(
        or(
          ilike(users.name, pattern),
          ilike(users.firstName, pattern),
          ilike(users.lastName, pattern),
          ilike(hrEmployments.designation, pattern),
          ilike(orgUnits.name, pattern),
        )!,
      );
    } else {
      conditions.push(sql<boolean>`not ${visibleManager}`);
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
        image: users.image,
        departmentId: orgUnits.id,
        departmentName: orgUnits.name,
        hasDirectReports,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
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
      .where(and(...conditions))
      .orderBy(asc(normalizedName), asc(users.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const pageRows = rows.slice(0, query.limit);
    const lastRow = pageRows.at(-1);
    const factsMap = await this.employment.getFactsBatch(orgId, pageRows.map((r) => r.id));

    return {
      data: pageRows.map((row) => ({
        id: row.id,
        name: row.name,
        role: toTitleCase(row.role ?? "Employee"),
        designation: factsMap.get(row.id)?.designation ?? null,
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
}
