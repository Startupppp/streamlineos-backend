import { Inject, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { z } from "zod";
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
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import type { ScopedRead } from "../../access/scoped-read";
import {
  decodeEmployeeListCursor,
  encodeEmployeeListCursor,
} from "./employee-list-cursor";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import {
  livePersonOfUser,
  primaryEmploymentOfPerson,
} from "../../directory/employment-query";
import { canonicalAdmissionEmail } from "../../organization/core/membership-admission.service";
import { findLivePrimaryEmploymentId } from "./employee-admission-status";
import type { checkEmailSchema, employeeCountsSchema } from "./dto/directory-response.schemas";

type EmployeeAdmissionCheck = z.infer<typeof checkEmailSchema>;
type EmployeeDirectoryCounts = z.infer<typeof employeeCountsSchema>;

export type EmployeeDirectoryFilters = {
  search?: string;
  departmentId?: string;
  role?: string;
};

function normalizeDirectoryFilters(opts: EmployeeDirectoryFilters): EmployeeDirectoryFilters {
  return {
    search: opts.search?.trim() || undefined,
    departmentId: opts.departmentId,
    role: opts.role?.trim() || undefined,
  };
}

function directoryFilterKey(filters: EmployeeDirectoryFilters): string {
  return `${filters.search ?? ""}:${filters.departmentId ?? ""}:${filters.role ?? ""}`;
}

@Injectable()
export class EmployeesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly employment: EmploymentFactsService,
  ) {}

  listEmployees(
    read: ScopedRead,
    opts: EmployeeDirectoryFilters & {
      cursor?: string;
      limit?: number;
      isActive?: "true" | "false" | "all";
    },
  ) {
    const limitN = opts.limit ?? 20;
    const isActive = opts.isActive ?? "true";
    const filters = normalizeDirectoryFilters(opts);

    const key = `cursor:${read.discriminator}:${opts.cursor ?? ""}:${limitN}:${directoryFilterKey(filters)}:${isActive}`;
    return this.cache.cachedVersioned(
      CACHE_KEYS.hrEmployeesListNamespace(read.orgId),
      key,
      () => this.getEmployeesPaginated(read, opts.cursor, limitN, filters, isActive),
      CACHE_TTL.SHORT,
    );
  }

  countEmployees(read: ScopedRead, opts: EmployeeDirectoryFilters): Promise<EmployeeDirectoryCounts> {
    const filters = normalizeDirectoryFilters(opts);
    const key = `counts:${read.discriminator}:${directoryFilterKey(filters)}`;
    return this.cache.cachedVersioned(
      CACHE_KEYS.hrEmployeesListNamespace(read.orgId),
      key,
      () => this.getEmployeeCounts(read, filters),
      CACHE_TTL.SHORT,
    );
  }

  async assertEmployeeVisible(read: ScopedRead, targetUserId: string): Promise<void> {
    const [visible] = await read.read(
      {
        tenant: organizationMembers.orgId,
        scope: { columns: { ownerColumn: organizationMembers.userId } },
        and: [eq(organizationMembers.userId, targetUserId)],
      },
      ({ sql: where }) =>
        this.db
          .select({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(where)
          .limit(1),
      () => [],
    );

    if (!visible) throw new NotFoundException("Employee not found");
  }

  private async directoryConditions(
    filters: EmployeeDirectoryFilters,
    isActive: "true" | "false" | "all",
  ): Promise<(SQL | undefined)[]> {
    const conditions: (SQL | undefined)[] = [];
    if (isActive === "true") conditions.push(eq(users.isActive, true));
    else if (isActive === "false") conditions.push(eq(users.isActive, false));
    if (filters.departmentId != null) conditions.push(eq(hrEmployments.departmentId, filters.departmentId));
    if (filters.role) conditions.push(eq(organizationMembers.role, filters.role));
    if (filters.search) conditions.push(await this.employeeSearchCondition(filters.search));
    return conditions;
  }

  private async getEmployeeCounts(
    read: ScopedRead,
    filters: EmployeeDirectoryFilters,
  ): Promise<EmployeeDirectoryCounts> {
    const orgId = read.orgId;
    const conditions = await this.directoryConditions(filters, "all");
    const [counts] = await read.read(
      {
        tenant: organizationMembers.orgId,
        scope: { columns: { ownerColumn: organizationMembers.userId } },
        and: conditions,
      },
      ({ sql: where }) =>
        this.db
          .select({
            active: sql<number>`count(*) filter (where ${users.isActive})`.mapWith(Number),
            inactive: sql<number>`count(*) filter (where not ${users.isActive})`.mapWith(Number),
          })
          .from(organizationMembers)
          .innerJoin(users, eq(organizationMembers.userId, users.id))
          .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
          .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
          .where(where),
      () => [],
    );
    return { active: counts?.active ?? 0, inactive: counts?.inactive ?? 0 };
  }

  private async getEmployeesPaginated(
    read: ScopedRead,
    encodedCursor: string | undefined,
    limit: number,
    filters: EmployeeDirectoryFilters,
    isActive: "true" | "false" | "all",
  ) {
    const orgId = read.orgId;
    const cursor = encodedCursor ? decodeEmployeeListCursor(encodedCursor) : undefined;
    const normalizedName = sql<string>`lower(coalesce(${users.name}, ''))`;

    const extraConditions = await this.directoryConditions(filters, isActive);
    if (cursor) {
      extraConditions.push(
        or(
          gt(normalizedName, cursor.name),
          and(
            eq(normalizedName, cursor.name),
            gt(users.id, cursor.employeeUserId),
          ),
        ),
      );
    }

    const dataResult = await read.read(
      {
        tenant: organizationMembers.orgId,
        scope: { columns: { ownerColumn: organizationMembers.userId } },
        and: extraConditions,
      },
      ({ sql: where }) =>
        this.db
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
          .limit(limit + 1),
      () => [],
    );

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

  async checkEmail(orgId: string, email: string): Promise<EmployeeAdmissionCheck> {
    const normalised = canonicalAdmissionEmail(email);
    const available: EmployeeAdmissionCheck = {
      exists: false,
      status: "available",
      memberStatus: null,
    };

    const existing = await this.db.query.users.findFirst({
      where: eq(users.email, normalised),
      columns: { id: true },
    });
    if (!existing) return available;

    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, existing.id),
      ),
      columns: { status: true },
    });
    if (!member) return available;

    if (member.status === "SUSPENDED" || member.status === "LEFT")
      return { exists: true, status: "archived-member", memberStatus: member.status };

    const employmentId = await findLivePrimaryEmploymentId(this.db, orgId, existing.id);
    return {
      exists: true,
      status: employmentId === null ? "member-without-employment" : "employee",
      memberStatus: null,
    };
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
      .limit(reportIds.length);

    const factsMap = await this.employment.getFactsBatch(orgId, rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, designation: factsMap.get(r.id)?.designation ?? null }));
  }

  private static readonly EMPLOYEE_SEARCH_CAP = 500;

  private async employeeSearchCondition(search: string): Promise<SQL> {
    const employmentIlike = or(
      ilike(hrEmployments.employeeNumber, `%${search}%`),
      ilike(hrEmployments.designation, `%${search}%`),
    );
    if (!employmentIlike) throw new InternalServerErrorException("Failed to build employee search fallback");
    const rows = await this.db.execute(
      sql`SELECT app.search_hr_person_ids(${search}, ${EmployeesService.EMPLOYEE_SEARCH_CAP + 1}) AS id`,
    );
    if (rows.length === 0) return employmentIlike;
    if (rows.length > EmployeesService.EMPLOYEE_SEARCH_CAP) {
      const wideFallback = or(
        ilike(users.name, `%${search}%`),
        ilike(users.email, `%${search}%`),
        ilike(users.firstName, `%${search}%`),
        ilike(users.lastName, `%${search}%`),
        employmentIlike,
      );
      if (!wideFallback) throw new InternalServerErrorException("Failed to build employee search fallback");
      return wideFallback;
    }
    const ids = rows.map((r) => Number(r["id"]));
    const condition = or(inArray(hrPeople.id, ids), employmentIlike);
    if (!condition) throw new InternalServerErrorException("Failed to build employee search condition");
    return condition;
  }

}
