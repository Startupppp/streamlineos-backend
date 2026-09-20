import { Injectable, Inject } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { z } from "zod";
import { and, eq, ilike } from "drizzle-orm";
import { leaveTypes } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AiConfirmationService } from "../../confirmation/ai-confirmation.service";
import { AttendanceService } from "../../../hr/time/attendance.service";
import {
  data,
  defineTool,
  empty,
  failed,
  needsConfirmation,
  type AskOsToolDefinition,
  type AskOsToolProvider,
  type AskOsToolRunContext,
  type ToolOutcome,
} from "../registry/ask-os-tool.types";
import { AskOsTools } from "../registry/ask-os-tools.decorator";

const CLOCK_PERMISSION = "self:attendance";
const CLOCK_MODULE = "hr";

function clockIdempotencyKey(ctx: AskOsToolRunContext, action: string): string {
  return `askos.attendance.${action}.${ctx.actor.orgId}.${ctx.actor.userId}.${ctx.actor.today}`;
}

async function resolveLeaveType(
  db: Db,
  orgId: string,
  name: string,
): Promise<{ id: number; name: string } | null> {
  const rows = await db
    .select({ id: leaveTypes.id, name: leaveTypes.name })
    .from(leaveTypes)
    .where(and(eq(leaveTypes.orgId, orgId), ilike(leaveTypes.name, name)))
    .limit(1);
  return rows[0] ?? null;
}

async function listLeaveTypeNames(db: Db, orgId: string): Promise<string[]> {
  const rows = await db
    .select({ name: leaveTypes.name })
    .from(leaveTypes)
    .where(eq(leaveTypes.orgId, orgId))
    .limit(50);
  return rows.map((row) => row.name);
}

@AskOsTools()
@Injectable()
export class SelfActionsTools implements AskOsToolProvider {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly confirmation: AiConfirmationService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private async runClockAction(
    ctx: AskOsToolRunContext,
    action: "clock-in" | "clock-out" | "toggle-break",
    invoke: (svc: AttendanceService, idempotencyKey: string) => Promise<unknown>,
  ): Promise<ToolOutcome> {
    const svc = this.moduleRef.get(AttendanceService, { strict: false });
    if (!svc) return failed("Attendance is unavailable right now.");
    try {
      const result = await invoke(svc, clockIdempotencyKey(ctx, action));
      const status = await svc.status(ctx.actor.orgId, ctx.actor.userId);
      return data({ action, result, status });
    } catch (error) {
      return failed(error instanceof Error ? error.message : "Clocking failed.");
    }
  }

  tools(): AskOsToolDefinition[] {
    return [
      defineTool({
        key: "clockIn",
        description:
          "Clock the caller in for today and start their work timer. Applies immediately with no confirmation step. Use when the user says to clock in, check in, or start their day.",
        input: z.object({}),
        permission: CLOCK_PERMISSION,
        module: CLOCK_MODULE,
        run: async (_input, ctx) =>
          this.runClockAction(ctx, "clock-in", (svc, key) =>
            Promise.resolve(svc.checkIn(ctx.actor.orgId, ctx.actor.userId, {}, key)),
          ),
      }),

      defineTool({
        key: "clockOut",
        description:
          "Clock the caller out for today and stop their work timer. Applies immediately with no confirmation step. Use when the user says to clock out, check out, or end their day.",
        input: z.object({}),
        permission: CLOCK_PERMISSION,
        module: CLOCK_MODULE,
        run: async (_input, ctx) =>
          this.runClockAction(ctx, "clock-out", (svc, key) =>
            Promise.resolve(svc.checkOut(ctx.actor.orgId, ctx.actor.userId, key)),
          ),
      }),

      defineTool({
        key: "toggleBreak",
        description:
          "Start or end the caller's break for today. Applies immediately with no confirmation step. Use when the user says they are going on a break or coming back from one.",
        input: z.object({}),
        permission: CLOCK_PERMISSION,
        module: CLOCK_MODULE,
        run: async (_input, ctx) =>
          this.runClockAction(ctx, "toggle-break", (svc, key) =>
            Promise.resolve(svc.toggleBreak(ctx.actor.orgId, ctx.actor.userId, key)),
          ),
      }),

      defineTool({
        key: "applyForLeave",
        description:
          "Submit a leave request for the caller. Requires user confirmation before the request is created. Use when the user says they want to apply for, book, or request leave.",
        input: z.object({
          leaveType: z
            .string()
            .min(1)
            .max(120)
            .describe("Leave type to apply for, by name — for example 'Casual Leave'"),
          startDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe("Leave start date (YYYY-MM-DD)"),
          endDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe("Leave end date (YYYY-MM-DD)"),
          reason: z.string().max(500).optional().describe("Optional reason for the leave request"),
        }),
        confirms: "self.applyLeave",
        module: "hr",
        run: async (input, ctx) => {
          const { orgId, userId, today } = ctx.actor;
          const resolved = await resolveLeaveType(this.db, orgId, input.leaveType);
          if (resolved === null) {
            const offered = await listLeaveTypeNames(this.db, orgId);
            return offered.length === 0
              ? empty("leave types")
              : failed(
                  `No leave type named "${input.leaveType}". Available: ${offered.join(", ")}.`,
                );
          }
          const proposal = await this.confirmation.propose({
            orgId,
            userId,
            action: "self.applyLeave",
            payload: {
              leaveTypeId: resolved.id,
              startDate: input.startDate,
              endDate: input.endDate,
              reason: input.reason ?? null,
            },
            idempotencyKey: `${orgId}:${userId}:self.applyLeave:${today}:${String(resolved.id)}:${input.startDate}:${input.endDate}`,
          });
          return needsConfirmation({
            proposalId: proposal.proposalId,
            token: proposal.token,
            action: "self.applyLeave",
            summary: `Apply for ${resolved.name} from ${input.startDate} to ${input.endDate}`,
            preview: {
              leaveType: resolved.name,
              startDate: input.startDate,
              endDate: input.endDate,
              reason: input.reason ?? null,
            },
            expiresAt: proposal.expiresAt,
          });
        },
      }),

      defineTool({
        key: "submitExpense",
        description:
          "Submit an expense claim for the caller. Requires user confirmation before the expense is created. Use when the user wants to log, submit, or claim an expense.",
        input: z.object({
          amount: z.number().positive().describe("Expense amount in the organisation's base currency"),
          category: z.string().min(1).describe("Expense category (e.g. Travel, Meals, Software)"),
          description: z.string().min(1).max(500).describe("Description of what the expense was for"),
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("Expense date (YYYY-MM-DD); defaults to today if omitted"),
        }),
        confirms: "self.submitExpense",
        run: async (input, ctx) => {
          const { orgId, userId, today } = ctx.actor;
          const expenseDate = input.date ?? today;
          const proposal = await this.confirmation.propose({
            orgId,
            userId,
            action: "self.submitExpense",
            payload: {
              amount: input.amount,
              category: input.category,
              description: input.description,
              date: expenseDate,
            },
            idempotencyKey: `${orgId}:${userId}:self.submitExpense:${today}:${input.category}:${input.amount}`,
          });
          return needsConfirmation({
            proposalId: proposal.proposalId,
            token: proposal.token,
            action: "self.submitExpense",
            summary: `Submit expense: ${input.category} — ${input.amount}`,
            preview: {
              amount: input.amount,
              category: input.category,
              description: input.description,
              date: expenseDate,
            },
            expiresAt: proposal.expiresAt,
          });
        },
      }),

      defineTool({
        key: "logTimesheetEntry",
        description:
          "Log a timesheet entry for the caller. Requires user confirmation before the entry is saved. Use when the user wants to log hours, record time, or add a timesheet entry.",
        input: z.object({
          hours: z
            .number()
            .positive()
            .max(24)
            .describe("Number of hours worked (e.g. 7.5)"),
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("Date for the entry (YYYY-MM-DD); defaults to today if omitted"),
          description: z
            .string()
            .max(500)
            .optional()
            .describe("Optional description of work done"),
          projectId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Optional project ID to log the hours against"),
        }),
        confirms: "self.logTimesheet",
        module: "timesheets",
        run: async (input, ctx) => {
          const { orgId, userId, today } = ctx.actor;
          const entryDate = input.date ?? today;
          const proposal = await this.confirmation.propose({
            orgId,
            userId,
            action: "self.logTimesheet",
            payload: {
              hours: input.hours,
              date: entryDate,
              description: input.description ?? null,
              projectId: input.projectId ?? null,
            },
            idempotencyKey: `${orgId}:${userId}:self.logTimesheet:${today}:${entryDate}:${input.hours}`,
          });
          return needsConfirmation({
            proposalId: proposal.proposalId,
            token: proposal.token,
            action: "self.logTimesheet",
            summary: `Log ${input.hours}h on ${entryDate}`,
            preview: {
              hours: input.hours,
              date: entryDate,
              description: input.description ?? null,
              projectId: input.projectId ?? null,
            },
            expiresAt: proposal.expiresAt,
          });
        },
      }),

      defineTool({
        key: "submitReferral",
        description:
          "Submit a candidate referral on behalf of the caller. Requires user confirmation before the referral is created. Use when the user wants to refer someone for a job.",
        input: z.object({
          candidateName: z.string().min(1).describe("Full name of the candidate being referred"),
          candidateEmail: z.string().email().describe("Email address of the candidate"),
          jobPostingId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Optional job posting ID the candidate is being referred for"),
          notes: z
            .string()
            .max(500)
            .optional()
            .describe("Optional notes about the candidate's background or suitability"),
        }),
        confirms: "self.submitReferral",
        module: "hr",
        run: async (input, ctx) => {
          const { orgId, userId, today } = ctx.actor;
          const proposal = await this.confirmation.propose({
            orgId,
            userId,
            action: "self.submitReferral",
            payload: {
              candidateName: input.candidateName,
              candidateEmail: input.candidateEmail,
              jobPostingId: input.jobPostingId ?? null,
              notes: input.notes ?? null,
            },
            idempotencyKey: `${orgId}:${userId}:self.submitReferral:${today}:${input.candidateEmail}`,
          });
          return needsConfirmation({
            proposalId: proposal.proposalId,
            token: proposal.token,
            action: "self.submitReferral",
            summary: `Refer ${input.candidateName} (${input.candidateEmail})`,
            preview: {
              candidateName: input.candidateName,
              candidateEmail: input.candidateEmail,
              jobPostingId: input.jobPostingId ?? null,
              notes: input.notes ?? null,
            },
            expiresAt: proposal.expiresAt,
          });
        },
      }),
    ];
  }
}
