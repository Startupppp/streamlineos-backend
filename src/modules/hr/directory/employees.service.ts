import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  SQL,
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import {
  hrEmployments,
  hrPeople,
  organizationMembers,
  projectMembers,
  projects,
  ticketAssignees,
  tickets,
  users,
} from "../../../db/schema";
import { orgUnits } from "../../../db/schema/common/organization";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import {
  decodeEmployeeListCursor,
  encodeEmployeeListCursor,
} from "./employee-list-cursor";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import {
  livePersonOfUser,
  primaryEmploymentOfPerson,
} from "../../directory/employment-query";

@Injectable()
export class EmployeesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly employment: EmploymentFactsService,
  ) {}

  listEmployees(
    orgId: string,
    userId: string,
    opts: {
      cursor?: string;
      limit?: number;
      search?: string;
      departmentId?: string;
      isActive?: "true" | "false" | "all";
      role?: string;
    },
    scope: DataScope,
  ) {
    const search = opts.search;
    const limitN = opts.limit ?? 20;
    const isActive = opts.isActive ?? "true";
    const departmentId = opts.departmentId;
    const role = opts.role?.trim() || undefined;

    const key = `hr:employees:cursor:${orgId}:${userId}:${scope}:${opts.cursor ?? ""}:${limitN}:${search ?? ""}:${departmentId ?? ""}:${isActive}:${role ?? ""}`;
    return this.cache.cached(
      key,
      () =>
        this.getEmployeesPaginated(
          orgId,
          opts.cursor,
          limitN,
          search,
          userId,
          scope,
          departmentId,
          isActive,
          role,
        ),
      CACHE_TTL.SHORT,
    );
  }

  async assertEmployeeVisible(
    orgId: string,
    actorUserId: string,
    targetUserId: string,
    scope: DataScope,
  ): Promise<void> {
    const [visible] = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, targetUserId),
          applyScope(scope, orgId, actorUserId, {
            ownerColumn: organizationMembers.userId,
          }),
        ),
      )
      .limit(1);

    if (!visible) throw new NotFoundException("Employee not found");
  }

  private async getEmployeesPaginated(
    orgId: string,
    encodedCursor: string | undefined,
    limit: number,
    search: string | undefined,
    userId: string,
    scope: DataScope,
    departmentId?: string,
    isActive: "true" | "false" | "all" = "true",
    role?: string,
  ) {
    const cursor = encodedCursor ? decodeEmployeeListCursor(encodedCursor) : undefined;
    const normalizedName = sql<string>`lower(coalesce(${users.name}, ''))`;

    const baseConditions: SQL[] = [
      eq(organizationMembers.orgId, orgId),
      applyScope(scope, orgId, userId, { ownerColumn: organizationMembers.userId }),
    ];
    if (isActive === "true") baseConditions.push(eq(users.isActive, true));
    else if (isActive === "false") baseConditions.push(eq(users.isActive, false));
    if (departmentId != null) baseConditions.push(eq(hrEmployments.departmentId, departmentId));
    if (role) baseConditions.push(eq(organizationMembers.role, role));
    if (cursor) {
      baseConditions.push(
        or(
          gt(normalizedName, cursor.name),
          and(
            eq(normalizedName, cursor.name),
            gt(users.id, cursor.employeeUserId),
          ),
        )!,
      );
    }

    const searchCondition = search ? await this.employeeSearchCondition(search) : undefined;

    const where = searchCondition ? and(...baseConditions, searchCondition) : and(...baseConditions);

    const dataResult = await this.db
      .select({
          id: users.id,
          cursorName: normalizedName,
          name: users.name,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          role: organizationMembers.role,
          orgDepartmentId: orgUnits.id,
          orgDepartmentName: orgUnits.name,
          image: users.image,
          isActive: users.isActive,
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
        ),
      )
      .where(where)
      .orderBy(asc(normalizedName), asc(users.id))
      .limit(limit + 1);

    const hasMore = dataResult.length > limit;
    const pageRows = dataResult.slice(0, limit);
    const lastRow = pageRows.at(-1);
    const factsMap = await this.employment.getFactsBatch(orgId, pageRows.map((r) => r.id));

    return {
      data: pageRows.map((row) => {
        const facts = factsMap.get(row.id);
        return {
          id: row.id,
          name: row.name,
          firstName: row.firstName,
          lastName: row.lastName,
          email: row.email,
          role: row.role,
          designation: facts?.designation ?? null,
          employeeId: facts?.employeeNumber ?? null,
          department:
            row.orgDepartmentId != null && row.orgDepartmentName
              ? { id: row.orgDepartmentId, name: row.orgDepartmentName }
              : null,
          image: row.image,
          isActive: row.isActive,
          joiningDate: facts?.joiningDate ?? null,
          reportingTo: facts?.managerUserId ?? null,
        };
      }),
      pageInfo: {
        limit,
        hasMore,
        nextCursor:
          hasMore && lastRow
            ? encodeEmployeeListCursor({
                name: lastRow.cursorName,
                employeeUserId: lastRow.id,
              })
            : null,
      },
    };
  }

  async checkEmail(orgId: string, email: string) {
    const normalised = email.toLowerCase().trim();
    const existing = await this.db.query.users.findFirst({
      where: eq(users.email, normalised),
      columns: { id: true },
    });
    if (!existing) return { exists: false };
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, existing.id),
      ),
      columns: { userId: true },
    });
    return { exists: !!member };
  }

  getProjects(orgId: string, userId: string) {
    return this.db
      .select({
        id: projects.id,
        name: projects.name,
        key: projects.key,
        status: projects.status,
        role: projectMembers.role,
      })
      .from(projectMembers)
      .innerJoin(organizationMembers, and(
        eq(projectMembers.orgId, organizationMembers.orgId),
        eq(projectMembers.membershipId, organizationMembers.id),
        eq(organizationMembers.userId, userId),
      ))
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(and(eq(projectMembers.orgId, orgId), eq(projects.orgId, orgId)))
      .limit(100);
  }

  async getTickets(orgId: string, userId: string) {
    const data = await this.db
      .select({
        id: tickets.id,
        title: tickets.title,
        status: tickets.status,
        priority: tickets.priority,
        projectId: tickets.projectId,
        ticketNumber: tickets.ticketNumber,
      })
      .from(ticketAssignees)
      .innerJoin(tickets, and(eq(ticketAssignees.ticketId, tickets.id), eq(ticketAssignees.orgId, tickets.orgId)))
      .innerJoin(organizationMembers, and(
        eq(ticketAssignees.orgId, organizationMembers.orgId),
        eq(ticketAssignees.membershipId, organizationMembers.id),
        eq(organizationMembers.userId, userId),
      ))
      .where(and(eq(ticketAssignees.orgId, orgId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)))
      .orderBy(desc(tickets.id))
      .limit(50);

    return { data };
  }

  async getReportsToMe(orgId: string, employeeId: string) {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.userId, employeeId), eq(organizationMembers.orgId, orgId)),
      columns: { userId: true },
    });
    if (!member) throw new NotFoundException("Employee not found");

    const reportIds = await this.employment.getDirectReportUserIds(orgId, employeeId);
    if (reportIds.length === 0) return [];

    const rows = await this.db
      .select({
        id: users.id,
        name: users.name,
        image: users.image,
        email: users.email,
      })
      .from(users)
      .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          inArray(users.id, reportIds),
          eq(users.isActive, true),
        ),
      )
      .limit(500);

    const factsMap = await this.employment.getFactsBatch(orgId, rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, designation: factsMap.get(r.id)?.designation ?? null }));
  }

  private static readonly EMPLOYEE_SEARCH_CAP = 500;

  private async employeeSearchCondition(search: string): Promise<SQL> {
    const employmentIlike = or(
      ilike(hrEmployments.employeeNumber, `%${search}%`),
      ilike(hrEmployments.designation, `%${search}%`),
    )!;
    const rows = await this.db.execute(
      sql`SELECT app.search_hr_person_ids(${search}, ${EmployeesService.EMPLOYEE_SEARCH_CAP + 1}) AS id`,
    );
    if (rows.length === 0) return employmentIlike;
    if (rows.length > EmployeesService.EMPLOYEE_SEARCH_CAP)
      return or(
        ilike(users.name, `%${search}%`),
        ilike(users.email, `%${search}%`),
        ilike(users.firstName, `%${search}%`),
        ilike(users.lastName, `%${search}%`),
        employmentIlike,
      )!;
    const ids = rows.map((r) => Number(r["id"]));
    return or(inArray(hrPeople.id, ids), employmentIlike)!;
  }

}
