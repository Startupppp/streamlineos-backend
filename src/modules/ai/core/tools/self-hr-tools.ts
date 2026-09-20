import { Injectable, Inject } from "@nestjs/common";
import { and, count, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  attendance,
  expenses,
  hrEmployments,
  hrPeople,
  hrReportingLines,
  leaveBalances,
  leaveRequests,
  leaveTypes,
  orgUnits,
  users,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import {
  defineTool,
  data,
  empty,
  type AskOsToolDefinition,
  type AskOsToolProvider,
} from "../registry/ask-os-tool.types";
import { AskOsTools } from "../registry/ask-os-tools.decorator";
import { monthBounds } from "./lib/month-bounds";


@AskOsTools()
@Injectable()
export class SelfHrTools implements AskOsToolProvider {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  tools(): AskOsToolDefinition[] {
    return [
      defineTool({
        key: "getMyEmployment",
        description:
          "Get the caller's own employment facts: job title/designation, department, employment type, lifecycle status, manager, joining date, and work location. Never returns compensation, tax, or bank data.",
        input: z.object({}),
        run: async (_input, ctx) => {
          const { userId, orgId, today } = ctx.actor;
          const deptUnit = alias(orgUnits, "dept_unit");
          const locUnit = alias(orgUnits, "loc_unit");

          const empRows = await this.db
            .select({
              employmentId: hrEmployments.id,
              employeeNumber: hrEmployments.employeeNumber,
              designation: hrEmployments.designation,
              workerType: hrEmployments.workerType,
              lifecycleStatus: hrEmployments.lifecycleStatus,
              joiningDate: hrEmployments.joiningDate,
              departmentName: deptUnit.name,
              locationName: locUnit.name,
            })
            .from(hrPeople)
            .innerJoin(
              hrEmployments,
              and(
                eq(hrEmployments.orgId, hrPeople.orgId),
                eq(hrEmployments.personId, hrPeople.id),
                isNull(hrEmployments.deletedAt),
              ),
            )
            .leftJoin(
              deptUnit,
              and(
                eq(deptUnit.orgId, hrEmployments.orgId),
                eq(deptUnit.id, hrEmployments.departmentId),
              ),
            )
            .leftJoin(
              locUnit,
              and(
                eq(locUnit.orgId, hrEmployments.orgId),
                eq(locUnit.id, hrEmployments.locationId),
              ),
            )
            .where(
              and(
                eq(hrPeople.orgId, orgId),
                eq(hrPeople.userId, userId),
                isNull(hrPeople.deletedAt),
              ),
            )
            .orderBy(sql`${hrEmployments.isPrimary} DESC`, desc(hrEmployments.id))
            .limit(1);

          const emp = empRows[0];
          if (!emp) return empty("employment", "No employment record found.");

          const managerEmp = alias(hrEmployments, "mgr_emp");
          const managerPerson = alias(hrPeople, "mgr_person");

          const managerRows = await this.db
            .select({
              name: users.name,
              firstName: users.firstName,
              lastName: users.lastName,
              email: users.email,
            })
            .from(hrReportingLines)
            .innerJoin(
              managerEmp,
              and(
                eq(managerEmp.orgId, hrReportingLines.orgId),
                eq(managerEmp.id, hrReportingLines.managerEmploymentId),
              ),
            )
            .innerJoin(
              managerPerson,
              and(
                eq(managerPerson.orgId, managerEmp.orgId),
                eq(managerPerson.id, managerEmp.personId),
              ),
            )
            .leftJoin(users, eq(users.id, managerPerson.userId))
            .where(
              and(
                eq(hrReportingLines.orgId, orgId),
                eq(hrReportingLines.employmentId, emp.employmentId),
                eq(hrReportingLines.lineType, "primary"),
                gte(hrReportingLines.effectiveTo, today),
              ),
            )
            .limit(1);

          const mgr = managerRows[0];
          let managerName: string | null = null;
          if (mgr) {
            const fullName = `${mgr.firstName ?? ""} ${mgr.lastName ?? ""}`.trim();
            if (mgr.name?.trim()) {
              managerName = mgr.name.trim();
            } else if (fullName) {
              managerName = fullName;
            } else {
              managerName = mgr.email?.split("@")[0] ?? null;
            }
          }

          return data({
            employeeNumber: emp.employeeNumber,
            designation: emp.designation,
            employmentType: emp.workerType,
            status: emp.lifecycleStatus,
            department: emp.departmentName ?? null,
            workLocation: emp.locationName ?? null,
            joiningDate: emp.joiningDate,
            manager: managerName,
          });
        },
      }),

      defineTool({
        key: "getMyProfile",
        description:
          "Get the caller's own identity and employment basics. Never returns tax ID or bank details.",
        input: z.object({}),
        run: async (_input, ctx) => {
          const { userId } = ctx.actor;
          const row = await this.db.query.users.findFirst({
            where: eq(users.id, userId),
            columns: {
              id: true,
              name: true,
              firstName: true,
              lastName: true,
              email: true,
              image: true,
              phone: true,
              gender: true,
              dateOfBirth: true,
              bio: true,
              linkedinUrl: true,
              isActive: true,
              createdAt: true,
            },
          });
          if (!row) return empty("user", "Profile not found.");
          return data(row);
        },
      }),

      defineTool({
        key: "getMyAttendanceSummary",
        description:
          "Get the caller's attendance summary for a given month: days present and total work hours. Defaults to the current calendar month.",
        input: z.object({
          year: z.number().int().min(2000).max(2100).optional(),
          month: z.number().int().min(1).max(12).optional(),
        }),
        permission: "self:attendance",
        module: "hr",
        run: async (input, ctx) => {
          const { userId, orgId } = ctx.actor;
          const year = input.year ?? ctx.actor.currentYear;
          const month = input.month ?? ctx.actor.currentMonth;
          const bounds = monthBounds(year, month);

          const rows = await this.db
            .select({
              daysPresent: count(),
              totalHoursText: sql<string>`coalesce(sum(${attendance.workHours}::numeric), 0)::text`,
            })
            .from(attendance)
            .where(
              and(
                eq(attendance.orgId, orgId),
                eq(attendance.userId, userId),
                gte(attendance.date, bounds.start),
                lte(attendance.date, bounds.end),
              ),
            );

          const result = rows[0];
          const daysPresent = Number(result?.daysPresent ?? 0);
          if (daysPresent === 0) {
            return empty(
              "attendance",
              `No attendance records found for ${year}-${String(month).padStart(2, "0")}.`,
            );
          }

          return data({
            year,
            month,
            daysPresent,
            totalHours: Number(Number(result?.totalHoursText ?? "0").toFixed(2)),
          });
        },
      }),

      defineTool({
        key: "getMyAttendanceStatus",
        description:
          "Check whether the caller is currently clocked in, on break, clocked out, or offline for today.",
        input: z.object({}),
        permission: "self:attendance",
        module: "hr",
        run: async (_input, ctx) => {
          const { userId, orgId, today } = ctx.actor;

          const todayRows = await this.db.query.attendance.findMany({
            where: and(
              eq(attendance.orgId, orgId),
              eq(attendance.userId, userId),
              eq(attendance.date, today),
            ),
            orderBy: [desc(attendance.createdAt)],
            limit: 20,
            columns: {
              id: true,
              checkIn: true,
              checkOut: true,
              status: true,
              workHours: true,
            },
          });

          const openRecord =
            todayRows.find((r) => r.checkIn !== null && r.checkOut === null) ?? null;
          const latestRecord = openRecord ?? todayRows[0] ?? null;

          let currentStatus: "PRESENT" | "ON_BREAK" | "CHECKED_OUT" | "OFFLINE" = "OFFLINE";
          if (latestRecord !== null) {
            if (latestRecord.checkOut !== null) currentStatus = "CHECKED_OUT";
            else if (latestRecord.status === "ON_BREAK") currentStatus = "ON_BREAK";
            else currentStatus = "PRESENT";
          }

          return data({
            status: currentStatus,
            today,
            clockedIn: openRecord !== null,
            lastRecord:
              latestRecord !== null
                ? {
                    checkIn: latestRecord.checkIn,
                    checkOut: latestRecord.checkOut,
                    workHours: latestRecord.workHours,
                  }
                : null,
          });
        },
      }),

      defineTool({
        key: "getMyLeaveRequests",
        description:
          "Get the caller's own leave requests and current-year leave balances by type.",
        input: z.object({}),
        permission: "self:leaves",
        module: "hr",
        run: async (_input, ctx) => {
          const { userId, orgId, currentYear } = ctx.actor;

          const [requests, balances] = await Promise.all([
            this.db.query.leaveRequests.findMany({
              where: and(
                eq(leaveRequests.orgId, orgId),
                eq(leaveRequests.userId, userId),
              ),
              with: {
                leaveType: { columns: { id: true, name: true, daysPerYear: true } },
              },
              orderBy: [desc(leaveRequests.id)],
              limit: 20,
            }),
            this.db
              .select({
                leaveTypeName: leaveTypes.name,
                balance: leaveBalances.balance,
                daysPerYear: leaveTypes.daysPerYear,
              })
              .from(leaveBalances)
              .leftJoin(leaveTypes, eq(leaveTypes.id, leaveBalances.leaveTypeId))
              .where(
                and(
                  eq(leaveBalances.orgId, orgId),
                  eq(leaveBalances.userId, userId),
                  eq(leaveBalances.year, currentYear),
                ),
              )
              .limit(50),
          ]);

          if (requests.length === 0 && balances.length === 0)
            return empty("leave", "No leave records found.");

          return data({
            requests: requests.map((r) => ({
              id: r.id,
              leaveType: r.leaveType?.name ?? "Unknown",
              startDate: r.startDate,
              endDate: r.endDate,
              status: r.status,
              reason: r.reason,
            })),
            balances: balances.map((b) => ({
              leaveType: b.leaveTypeName ?? "Unknown",
              balance: Number(b.balance),
              daysPerYear: b.daysPerYear,
            })),
            year: currentYear,
          });
        },
      }),

      defineTool({
        key: "getMyExpenses",
        description:
          "Get the caller's own expense claims, most recent first. Returns up to 30 records; capped is true when more may exist.",
        input: z.object({}),
        permission: "self:expenses",
        run: async (_input, ctx) => {
          const { userId, orgId } = ctx.actor;

          const rows = await this.db.query.expenses.findMany({
            where: and(
              eq(expenses.orgId, orgId),
              eq(expenses.userId, userId),
            ),
            orderBy: [desc(expenses.expenseDate)],
            limit: 30,
            columns: {
              id: true,
              category: true,
              amount: true,
              currency: true,
              description: true,
              status: true,
              expenseDate: true,
              merchant: true,
            },
          });

          if (rows.length === 0) return empty("expenses", "No expense records found.");

          return data({
            expenses: rows.map((r) => ({
              id: r.id,
              category: r.category,
              amount: r.amount,
              currency: r.currency,
              description: r.description,
              status: r.status,
              expenseDate: r.expenseDate,
              merchant: r.merchant,
            })),
            total: rows.length,
            capped: rows.length === 30,
          });
        },
      }),
    ];
  }
}
