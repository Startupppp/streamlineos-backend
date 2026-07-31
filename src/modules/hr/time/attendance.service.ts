import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  attendance,
  organizationMembers,
  organizations,
  orgHolidays,
  users,
} from "../../../db/schema";
import { orgUnits } from "../../../db/schema/common/organization";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import { EmailService } from "../../email/email.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { formatDateOnly, getTodayString } from "../../../common/date";
import type {
  AttendanceEmailReportInput,
  CheckInInput,
  TeamStatusQuery,
} from "./dto/attendance.schemas";
import { resolveAttendanceScope } from "./attendance-scope";
import { randomUUID } from "node:crypto";
import { AttendanceClockService } from "./attendance-clock.service";
import { AttendanceReadService } from "./attendance-read.service";

type AttendanceStatus = "OFFLINE" | "PRESENT" | "ON_BREAK" | "CHECKED_OUT";

@Injectable()
export class AttendanceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly email: EmailService,
    private readonly clock: AttendanceClockService,
    private readonly reader: AttendanceReadService,
  ) {}

  checkIn(orgId: string, userId: string, body: CheckInInput) {
    return this.clock.checkIn(orgId, userId, body);
  }

  checkOut(orgId: string, userId: string, localDate?: string) {
    return this.clock.checkOut(orgId, userId, localDate);
  }

  toggleBreak(orgId: string, userId: string) {
    return this.clock.toggleBreak(orgId, userId);
  }

  status(orgId: string, userId: string) {
    return this.reader.status(orgId, userId);
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
      .selectDistinctOn([attendance.userId], {
        userId: attendance.userId,
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
        attendance.userId,
        desc(sql`${attendance.checkOut} IS NULL`),
        desc(attendance.createdAt),
      )
      .as("today_status");

    const statusExpr = sql<AttendanceStatus>`COALESCE(${todayStatus.status}, 'OFFLINE')`;

    const baseConditions = [
      eq(organizationMembers.orgId, u.orgId),
      eq(users.isActive, true),
    ];
    if (query.departmentId !== undefined) {
      baseConditions.push(eq(users.departmentId, query.departmentId));
    }
    if (query.search) {
      const term = `%${query.search}%`;
      baseConditions.push(
        sql`(${users.name} ILIKE ${term} OR ${users.email} ILIKE ${term} OR ${users.firstName} ILIKE ${term} OR ${users.lastName} ILIKE ${term})`,
      );
    }

    const rowConditions = [...baseConditions];
    if (query.status) rowConditions.push(sql`${statusExpr} = ${query.status}`);

    const offset = (query.page - 1) * query.limit;

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
        .leftJoin(todayStatus, eq(todayStatus.userId, organizationMembers.userId))
        .leftJoin(
          orgUnits,
          and(
            eq(orgUnits.id, users.orgDepartmentId),
            eq(orgUnits.kind, "DEPARTMENT"),
          ),
        )
        .where(and(...rowConditions))
        .orderBy(
          sql`CASE ${statusExpr} WHEN 'PRESENT' THEN 0 WHEN 'ON_BREAK' THEN 1 WHEN 'CHECKED_OUT' THEN 2 ELSE 3 END`,
          asc(users.name),
        )
        .limit(query.limit)
        .offset(offset),
      this.db
        .select({ status: statusExpr, count: sql<number>`count(*)::int` })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .leftJoin(todayStatus, eq(todayStatus.userId, organizationMembers.userId))
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

    const data = rows.map((m) => {
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
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
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
    const [holiday] = await this.db
      .update(orgHolidays)
      .set(updateData)
      .where(and(eq(orgHolidays.id, id), eq(orgHolidays.orgId, orgId)))
      .returning();
    if (!holiday) throw new NotFoundException("Holiday not found");
    return holiday;
  }

  async deleteHoliday(orgId: string, id: string) {
    await this.db
      .delete(orgHolidays)
      .where(and(eq(orgHolidays.id, id), eq(orgHolidays.orgId, orgId)));
  }

  async emailReport(
    u: CurrentUserContext,
    input: AttendanceEmailReportInput,
  ): Promise<{ sent: number }> {
    const now = new Date();
    const startDate =
      input.startDate ??
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const endDate = input.endDate ?? formatDateOnly(now);

    const [orgRow, rows] = await Promise.all([
      this.db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, u.orgId))
        .then((r) => r[0]),
      this.db
        .select({
          date: attendance.date,
          userName: sql<string>`coalesce(${users.name}, ${users.email}, 'Unknown')`,
          workHours: attendance.workHours,
          autoCheckout: attendance.autoCheckedOut,
        })
        .from(attendance)
        .innerJoin(users, eq(users.id, attendance.userId))
        .where(
          and(
            eq(attendance.orgId, u.orgId),
            gte(attendance.date, startDate),
            lte(attendance.date, endDate),
          ),
        )
        .orderBy(asc(attendance.date), asc(users.name)),
    ]);

    const orgName = orgRow?.name ?? "Your Organisation";
    const dateRange = `${startDate} to ${endDate}`;
    const recipients = [...input.to, ...input.cc, ...input.bcc];

    await this.email.sendWeeklyAttendanceReportEmail(
      dateRange,
      orgName,
      rows.map((r) => ({
        department: "",
        name: r.userName,
        totalHours: r.workHours ?? "0",
        autoCheckoutDays: r.autoCheckout ? 1 : 0,
        overtimeDays: 0,
        daysPresent: 1,
      })),
      recipients,
    );

    return { sent: recipients.length };
  }
}
