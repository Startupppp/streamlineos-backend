import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { hasPatchValues } from "../../../common/db/patch-values";
import {
  attendance,
  hrEmployments,
  hrPeople,
  organizationMembers,
  orgHolidays,
  users,
} from "../../../db/schema";
import { orgUnits } from "../../../db/schema/common/organization";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import { EmailService } from "../../email/email.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { getTodayString } from "../../../common/date";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  AttendanceEmailReportInput,
  CheckInInput,
  TeamStatusQuery,
} from "./dto/attendance.schemas";
import { resolveAttendanceScope } from "./attendance-scope";
import { randomUUID } from "node:crypto";
import { AttendanceClockService } from "./attendance-clock.service";
import { AttendanceReadService } from "./attendance-read.service";
import { livePersonOfUser, orgUnitInOrg, primaryEmploymentOfPerson } from "../../directory/employment-query";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { queueAttendanceEmailReport } from "./attendance-email-report.service";

type AttendanceStatus = "OFFLINE" | "PRESENT" | "ON_BREAK" | "CHECKED_OUT";
function attendanceStatusRank(status: AttendanceStatus): number {
  switch (status) {
    case "PRESENT":
      return 0;
    case "ON_BREAK":
      return 1;
    case "CHECKED_OUT":
      return 2;
    case "OFFLINE":
      return 3;
  }
}

function decodeTeamStatusCursor(value: string | undefined) {
  if (value === undefined) return null;
  const position = decodeCursor(value);
  if (!position) throw new BadRequestException("Invalid pagination cursor");

  try {
    const parsed: unknown = JSON.parse(position.sortValue);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !Number.isInteger(parsed[0]) ||
      (parsed[1] !== null && typeof parsed[1] !== "string")
    ) {
      throw new Error("invalid team status cursor");
    }
    const rank = parsed[0] as number;
    if (rank < 0 || rank > 3) throw new Error("invalid status rank");
    return { rank, name: parsed[1] as string | null, userId: position.id };
  } catch {
    throw new BadRequestException("Invalid pagination cursor");
  }
}

@Injectable()
export class AttendanceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly email: EmailService,
    private readonly clock: AttendanceClockService,
    private readonly reader: AttendanceReadService,
    private readonly audit: AuditService,
  ) {}

  checkIn(
    organizationId: string,
    userId: string,
    input: CheckInInput,
    idempotencyKey: string,
  ) {
    return this.clock.checkIn(
      organizationId,
      userId,
      input,
      idempotencyKey,
    );
  }

  checkOut(organizationId: string, userId: string, idempotencyKey: string) {
    return this.clock.checkOut(organizationId, userId, idempotencyKey);
  }

  toggleBreak(organizationId: string, userId: string, idempotencyKey: string) {
    return this.clock.toggleBreak(organizationId, userId, idempotencyKey);
  }

  status(orgId: string, userId: string) {
    return this.reader.status(orgId, userId);
  }

  history(orgId: string, userId: string, page: number, limit: number) {
    return this.reader.history(orgId, userId, page, limit);
  }

  logs(
    u: CurrentUserContext,
    requestedUserId: string | undefined,
    year?: number,
    month?: number,
  ) {
    return this.reader.logs(u, requestedUserId, year, month);
  }

  monthly(
    u: CurrentUserContext,
    targetUserId: string,
    year: number,
    month: number,
  ) {
    return this.reader.monthly(u, targetUserId, year, month);
  }

  heatmap(u: CurrentUserContext, targetUserId: string, year: number) {
    return this.reader.heatmap(u, targetUserId, year);
  }

  async teamStatus(u: CurrentUserContext, query: TeamStatusQuery) {
    const scope = await resolveAttendanceScope(this.access, u);
    if (scope !== "all")
      throw new ForbiddenException("Only admins can view team attendance.");

    const today = getTodayString();

    const todayStatus = this.db
      .selectDistinctOn([attendance.userMembershipId], {
        userMembershipId: attendance.userMembershipId,
        status: sql<string>`CASE WHEN ${attendance.checkOut} IS NOT NULL THEN 'CHECKED_OUT' WHEN ${attendance.status} = 'ON_BREAK' THEN 'ON_BREAK' ELSE 'PRESENT' END`.as(
          "derived_status",
        ),
        checkIn: attendance.checkIn,
        checkOut: attendance.checkOut,
        workHours: attendance.workHours,
      })
      .from(attendance)
      .where(and(eq(attendance.orgId, u.orgId), eq(attendance.date, today)))
      .orderBy(
        attendance.userMembershipId,
        desc(sql`${attendance.checkOut} IS NULL`),
        desc(attendance.createdAt),
      )
      .as("today_status");

    const statusExpr = sql<AttendanceStatus>`COALESCE(${todayStatus.status}, 'OFFLINE')`;
    const statusRankExpr = sql<number>`CASE ${statusExpr} WHEN 'PRESENT' THEN 0 WHEN 'ON_BREAK' THEN 1 WHEN 'CHECKED_OUT' THEN 2 ELSE 3 END`;

    const baseConditions = [
      eq(organizationMembers.orgId, u.orgId),
      eq(organizationMembers.status, "ACTIVE"),
      eq(users.isActive, true),
    ];
    if (query.departmentId !== undefined) {
      baseConditions.push(eq(hrEmployments.departmentId, query.departmentId));
    }
    if (query.search) {
      const term = `%${query.search}%`;
      baseConditions.push(
        sql`(${users.name} ILIKE ${term} OR ${users.email} ILIKE ${term} OR ${users.firstName} ILIKE ${term} OR ${users.lastName} ILIKE ${term})`,
      );
    }

    const rowConditions = [...baseConditions];
    if (query.status) rowConditions.push(sql`${statusExpr} = ${query.status}`);
    const cursorPosition = decodeTeamStatusCursor(query.cursor);
    if (cursorPosition) {
      const nameAfter = cursorPosition.name === null
        ? and(
            isNull(users.name),
            gt(organizationMembers.userId, cursorPosition.userId),
          )
        : or(
            gt(users.name, cursorPosition.name),
            isNull(users.name),
            and(
              eq(users.name, cursorPosition.name),
              gt(organizationMembers.userId, cursorPosition.userId),
            ),
          );
      rowConditions.push(
        or(
          sql`${statusRankExpr} > ${cursorPosition.rank}`,
          and(sql`${statusRankExpr} = ${cursorPosition.rank}`, nameAfter),
        )!,
      );
    }

    const [rows, countRows] = await Promise.all([
      this.db
        .select({
          userId: organizationMembers.userId,
          userName: users.name,
          userFirstName: users.firstName,
          userLastName: users.lastName,
          userEmail: users.email,
          userImage: users.image,
          orgDepartmentName: orgUnits.name,
          status: statusExpr,
          checkIn: todayStatus.checkIn,
          checkOut: todayStatus.checkOut,
          workHours: todayStatus.workHours,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .leftJoin(hrPeople, livePersonOfUser(u.orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(u.orgId))
        .leftJoin(todayStatus, eq(todayStatus.userMembershipId, organizationMembers.id))
        .leftJoin(
          orgUnits,
          and(
            orgUnitInOrg(u.orgId, hrEmployments.departmentId),
            eq(orgUnits.kind, "DEPARTMENT"),
          ),
        )
        .where(and(...rowConditions))
        .orderBy(
          statusRankExpr,
          asc(users.name),
          asc(organizationMembers.userId),
        )
        .limit(query.limit + 1),
      this.db
        .select({ status: statusExpr, count: sql<number>`count(*)::int` })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .leftJoin(hrPeople, livePersonOfUser(u.orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(u.orgId))
        .leftJoin(todayStatus, eq(todayStatus.userMembershipId, organizationMembers.id))
        .where(and(...baseConditions))
        .groupBy(statusExpr),
    ]);

    const counts: Record<AttendanceStatus, number> = {
      PRESENT: 0,
      ON_BREAK: 0,
      CHECKED_OUT: 0,
      OFFLINE: 0,
    };
    for (const row of countRows) {
      const status = row.status as AttendanceStatus;
      if (status in counts) counts[status] = row.count;
    }

    const total = query.status
      ? counts[query.status]
      : counts.PRESENT +
        counts.ON_BREAK +
        counts.CHECKED_OUT +
        counts.OFFLINE;

    const page = buildCursorPage(rows, query.limit, (row) => ({
      sortValue: JSON.stringify([
        attendanceStatusRank(row.status),
        row.userName,
      ]),
      id: row.userId,
    }));

    const data = page.data.map((m) => {
      const name =
        m.userName ||
        [m.userFirstName, m.userLastName].filter(Boolean).join(" ") ||
        m.userEmail;
      return {
        userId: m.userId,
        name,
        email: m.userEmail,
        image: m.userImage,
        department: m.orgDepartmentName ?? null,
        status: m.status,
        checkIn: m.checkIn ?? null,
        checkOut: m.checkOut ?? null,
        workHours: m.workHours ?? null,
      };
    });

    return {
      data,
      counts,
      pagination: {
        ...page.pagination,
        total,
      },
    };
  }

  async listHolidays(orgId: string) {
    return this.db
      .select()
      .from(orgHolidays)
      .where(eq(orgHolidays.orgId, orgId))
      .orderBy(asc(orgHolidays.date))
      .limit(100);
  }

  async createHoliday(
    orgId: string,
    createdBy: string,
    data: { name: string; date: string; recurring?: boolean },
  ) {
    const trimmedName = data.name.trim();
    const duplicate = await this.db.query.orgHolidays.findFirst({
      where: and(
        eq(orgHolidays.orgId, orgId),
        eq(orgHolidays.date, data.date),
        sql`lower(trim(${orgHolidays.name})) = ${trimmedName.toLowerCase()}`,
      ),
      columns: { id: true },
    });
    if (duplicate) {
      throw new ConflictException(
        "A holiday with this name already exists on this date.",
      );
    }
    const [holiday] = await this.db
      .insert(orgHolidays)
      .values({
        id: randomUUID(),
        orgId,
        createdBy,
        name: trimmedName,
        date: data.date,
        recurring: data.recurring ?? false,
      })
      .returning();
    return holiday;
  }

  async updateHoliday(
    orgId: string,
    id: string,
    data: { name?: string; date?: string; recurring?: boolean },
  ) {
    const updateData: { name?: string; date?: string; recurring?: boolean } = {
      ...data,
    };
    if (updateData.name !== undefined) {
      updateData.name = updateData.name.trim();
    }
    const scope = and(eq(orgHolidays.id, id), eq(orgHolidays.orgId, orgId));
    const [holiday] = hasPatchValues(updateData)
      ? await this.db.update(orgHolidays).set(updateData).where(scope).returning()
      : await this.db.select().from(orgHolidays).where(scope).limit(1);
    if (!holiday) throw new NotFoundException("Holiday not found");
    return holiday;
  }

  async deleteHoliday(orgId: string, id: string) {
    const removed = await this.db
      .delete(orgHolidays)
      .where(and(eq(orgHolidays.id, id), eq(orgHolidays.orgId, orgId)))
      .returning({ id: orgHolidays.id });
    if (removed.length === 0) throw new NotFoundException("Holiday not found");
  }

  emailReport(
    u: CurrentUserContext,
    input: AttendanceEmailReportInput,
  ): Promise<{ queued: number }> {
    return queueAttendanceEmailReport(this.db, this.access, this.email, this.audit, u, input);
  }
}
