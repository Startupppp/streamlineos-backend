import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, countDistinct, eq, gte, ilike, like, or, sql } from "drizzle-orm";
import {
  auditLogs,
  hrEmployments,
  hrPeople,
  organizationMembers,
  principalGroups,
  roleAssignments,
  roles,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  livePersonOfUser,
  primaryEmploymentOfPerson,
} from "../directory/employment-query";
import { PERMISSIONS } from "./permissions";
import type { SimulationCandidatesQuery } from "./dto/rbac.schemas";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetAfterTextExpression } from "../../common/pagination/keyset";

@Injectable()
export class RolesQueryService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listAssignableDepartments(orgId: string) {
    return this.db
      .select({
        id: principalGroups.id,
        name: principalGroups.name,
        kind: principalGroups.kind,
      })
      .from(principalGroups)
      .where(eq(principalGroups.orgId, orgId))
      .orderBy(asc(principalGroups.name))
      .limit(500);
  }

  async listSimulationCandidates(
    orgId: string,
    input: SimulationCandidatesQuery,
  ) {
    const conditions = [
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.status, "ACTIVE"),
    ];
    if (input.search) {
      const searchCondition = or(
        ilike(users.name, `%${input.search}%`),
        ilike(users.email, `%${input.search}%`),
      );
      if (searchCondition) conditions.push(searchCondition);
    }
    const normalizedName = sql<string>`coalesce(${users.name}, ${"\uffff"})`;
    const position = decodeCursor(input.cursor);
    const where = and(
      ...conditions,
      position
        ? keysetAfterTextExpression(normalizedName, users.name, users.email, position)
        : undefined,
    );
    const rows = await this.db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          image: users.image,
          designation: hrEmployments.designation,
          cursorSortValue: normalizedName,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .where(where)
        .orderBy(asc(normalizedName), asc(users.email))
        .limit(input.limit + 1);
    const page = buildCursorPage(rows, input.limit, (row) => ({
      sortValue: row.cursorSortValue,
      id: row.email,
    }));
    return {
      data: page.data.map(({ cursorSortValue: _cursor, ...row }) => row),
      pagination: page.pagination,
    };
  }

  async getSimulationTarget(orgId: string, targetUserId: string) {
    const target = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, targetUserId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { isOwner: true },
    });
    if (!target) throw new NotFoundException("Organization member not found");
    return target;
  }

  async getRoleAnalytics(orgId: string): Promise<{
    totalRoles: number;
    customRoles: number;
    systemRoles: number;
    totalPermissions: number;
    usersAssigned: number;
    recentChanges: number;
  }> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [roleTotalsRows, assignedRows, changesRows] = await Promise.all([
      this.db
        .select({
          totalRoles: count(),
          systemRoles: sql<number>`count(*) filter (where ${roles.isSystem})`,
          customRoles: sql<number>`count(*) filter (where not ${roles.isSystem})`,
        })
        .from(roles)
        .where(eq(roles.orgId, orgId))
        .limit(1),
      this.db
        .select({
          value: countDistinct(roleAssignments.organizationMembershipId),
        })
        .from(roleAssignments)
        .where(eq(roleAssignments.orgId, orgId))
        .limit(1),
      this.db
        .select({ value: count() })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.orgId, orgId),
            like(auditLogs.action, "role.%"),
            gte(auditLogs.createdAt, sevenDaysAgo),
          ),
        )
        .limit(1),
    ]);
    const roleTotals = roleTotalsRows[0];
    const assignedRow = assignedRows[0];
    const changesRow = changesRows[0];

    return {
      totalRoles: Number(roleTotals?.totalRoles ?? 0),
      customRoles: Number(roleTotals?.customRoles ?? 0),
      systemRoles: Number(roleTotals?.systemRoles ?? 0),
      totalPermissions: PERMISSIONS.length,
      usersAssigned: Number(assignedRow?.value ?? 0),
      recentChanges: Number(changesRow?.value ?? 0),
    };
  }
}
