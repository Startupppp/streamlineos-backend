import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from "@nestjs/common";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import {
  attendance,
  organizationMembers,
  organizations,
  users,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import { EmailService } from "../../email/email.service";
import type { AttendanceEmailReportInput } from "./dto/attendance.schemas";
import {
  ATTENDANCE_REPORT_MAX_DAYS,
  ATTENDANCE_REPORT_RECIPIENT_LIMIT,
} from "./dto/attendance.schemas";
import { attendanceMemberScope, resolveAttendanceScope } from "./attendance-scope";
import { requireOrganizationMembershipId } from "./organization-membership";

const ATTENDANCE_REPORT_ROW_LIMIT = 100;

export async function queueAttendanceEmailReport(
  db: Db,
  access: AccessService,
  email: EmailService,
  audit: AuditService,
  u: CurrentUserContext,
  input: AttendanceEmailReportInput,
): Promise<{ queued: number }> {
  const scope = await resolveAttendanceScope(access, u);
  if (scope === "none") {
    throw new ForbiddenException("You do not have permission to email attendance reports.");
  }
  const actorMembershipId = await requireOrganizationMembershipId(db, u.orgId, u.userId);

  const recipients = [...input.to, ...input.cc, ...input.bcc].map((recipient) =>
    recipient.trim().toLowerCase(),
  );
  if (
    recipients.length === 0 ||
    recipients.length > ATTENDANCE_REPORT_RECIPIENT_LIMIT ||
    new Set(recipients).size !== recipients.length
  ) {
    throw new BadRequestException(
      `Select between 1 and ${ATTENDANCE_REPORT_RECIPIENT_LIMIT} unique recipients.`,
    );
  }

  const [orgRow] = await db
    .select({ name: organizations.name, timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, u.orgId))
    .limit(1);
  if (!orgRow) throw new NotFoundException("Organization not found.");

  const today = formatInTimeZone(new Date(), orgRow.timezone, "yyyy-MM-dd");
  const startDate = input.startDate ?? `${today.slice(0, 7)}-01`;
  const endDate = input.endDate ?? today;
  const dayCount =
    (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) /
      86_400_000 +
    1;
  if (
    Boolean(input.startDate) !== Boolean(input.endDate) ||
    !Number.isInteger(dayCount) ||
    dayCount < 1 ||
    dayCount > ATTENDANCE_REPORT_MAX_DAYS ||
    startDate > today ||
    endDate > today
  ) {
    throw new BadRequestException(
      `Select a valid past-or-present date range of at most ${ATTENDANCE_REPORT_MAX_DAYS} days.`,
    );
  }

  const recipientRows = await db
    .select({ email: users.email, userId: users.id })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.orgId, u.orgId),
        eq(organizationMembers.status, "ACTIVE"),
        inArray(sql<string>`lower(${users.email})`, recipients),
      ),
    );
  const activeMemberEmails = new Set(
    recipientRows.map((row) => row.email.trim().toLowerCase()),
  );
  if (recipients.some((recipient) => !activeMemberEmails.has(recipient))) {
    throw new BadRequestException(
      "Attendance reports can only be emailed to active members of this organization.",
    );
  }

  const rows = await db
    .select({
      userId: organizationMembers.userId,
      userName: sql<string>`coalesce(${users.name}, ${users.email}, 'Unknown')`,
      totalHours: sql<string>`coalesce(sum(${attendance.workHours}), 0)`,
      autoCheckoutDays: sql<number>`count(*) filter (where ${attendance.autoCheckedOut} = true)::integer`,
      overtimeDays: sql<number>`count(*) filter (where ${attendance.isOvertime} = true)::integer`,
      daysPresent: sql<number>`count(*) filter (where ${attendance.checkIn} is not null)::integer`,
    })
    .from(attendance)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, attendance.orgId),
        eq(organizationMembers.id, attendance.userMembershipId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
    )
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(attendance.orgId, u.orgId),
        gte(attendance.date, startDate),
        lte(attendance.date, endDate),
        attendanceMemberScope(scope, actorMembershipId),
      ),
    )
    .groupBy(organizationMembers.userId, users.name, users.email)
    .orderBy(asc(users.name), asc(organizationMembers.userId))
    .limit(ATTENDANCE_REPORT_ROW_LIMIT + 1);

  if (rows.length > ATTENDANCE_REPORT_ROW_LIMIT) {
    throw new PayloadTooLargeException(
      `Email reports support up to ${ATTENDANCE_REPORT_ROW_LIMIT} employees. Use a narrower attendance data scope.`,
    );
  }

  const dateRange = `${startDate} to ${endDate}`;
  await audit.logCritical({
    action: "hr.attendance_report.email_requested",
    userId: u.userId,
    orgId: u.orgId,
    targetId: dateRange,
    targetType: "attendance_report",
    result: "SUCCESS",
    metadata: {
      dataScope: scope,
      startDate,
      endDate,
      employeeCount: rows.length,
      recipientCount: recipients.length,
      deliveryStatus: "QUEUED",
    },
  });

  const queued = await email.queueAttendanceReportEmail(
    dateRange,
    orgRow.name,
    rows.map((row) => ({
      department: "",
      name: row.userName,
      totalHours: row.totalHours,
      autoCheckoutDays: Number(row.autoCheckoutDays),
      overtimeDays: Number(row.overtimeDays),
      daysPresent: Number(row.daysPresent),
    })),
    recipientRows.map((recipient) => ({
      email: recipient.email.trim().toLowerCase(),
      userId: recipient.userId,
    })),
    u.orgId,
  );

  return { queued };
}
