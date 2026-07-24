import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { attendance, hrAttendanceRegularizations } from "../../db/schema";
import { PayrollInputsService } from "../hr-payroll-inputs/payroll-inputs.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { HrWorkflowEngineService } from "../hr-workflows/hr-workflow-engine.service";
import { AccessService } from "../access/access.service";
import { resolveAttendanceScope } from "./attendance-scope";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { logger } from "../../common/logger/logger.service";
import { AuditService } from "../../common/audit/audit.service";

export interface CreateRegularizationInput {
  attendanceDate: string;
  requestedCheckIn?: string;
  requestedCheckOut?: string;
  reason: string;
}

export interface ListRegularizationsQuery {
  userId?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class AttendanceRegularizationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly workflowEngine: HrWorkflowEngineService,
    private readonly access: AccessService,
    private readonly payrollInputs: PayrollInputsService,
    private readonly audit: AuditService,
  ) {}

  async create(u: CurrentUserContext, input: CreateRegularizationInput) {
    if (!input.requestedCheckIn && !input.requestedCheckOut) {
      throw new BadRequestException("At least one of requestedCheckIn or requestedCheckOut is required.");
    }

    const existingPending = await this.db.query.hrAttendanceRegularizations.findFirst({
      where: and(
        eq(hrAttendanceRegularizations.orgId, u.orgId),
        eq(hrAttendanceRegularizations.userId, u.userId),
        eq(hrAttendanceRegularizations.attendanceDate, input.attendanceDate),
        eq(hrAttendanceRegularizations.status, "PENDING"),
      ),
    });

    if (existingPending) {
      throw new BadRequestException("A pending regularization already exists for this date.");
    }

    const attendanceRow = await this.db.query.attendance.findFirst({
      where: and(
        eq(attendance.orgId, u.orgId),
        eq(attendance.userId, u.userId),
        eq(attendance.date, input.attendanceDate),
      ),
    });

    const [regularization] = await this.db
      .insert(hrAttendanceRegularizations)
      .values({
        orgId: u.orgId,
        userId: u.userId,
        attendanceDate: input.attendanceDate,
        requestedCheckIn: input.requestedCheckIn ? new Date(input.requestedCheckIn) : null,
        requestedCheckOut: input.requestedCheckOut ? new Date(input.requestedCheckOut) : null,
        reason: input.reason,
        status: "PENDING",
        attendanceId: attendanceRow?.id ?? null,
      })
      .returning();

    if (!regularization) throw new BadRequestException("Failed to create regularization.");

    const instance = await this.workflowEngine.startWorkflow({
      orgId: u.orgId,
      objectType: "attendance_regularization",
      objectId: String(regularization.id),
      requestedByUserId: u.userId,
      subjectEmployeeId: u.userId,
      context: {
        attendanceDate: input.attendanceDate,
        reason: input.reason,
        requestedCheckIn: input.requestedCheckIn ?? null,
        requestedCheckOut: input.requestedCheckOut ?? null,
      },
    }).catch(() => null);

    if (instance) {
      await this.db
        .update(hrAttendanceRegularizations)
        .set({ workflowInstanceId: String(instance.id) })
        .where(eq(hrAttendanceRegularizations.id, regularization.id));
    }

    return { ...regularization, workflowInstanceId: instance ? String(instance.id) : null };
  }

  async list(u: CurrentUserContext, query: ListRegularizationsQuery) {
    const scope = await resolveAttendanceScope(this.access, u);
    const targetUserId = query.userId ?? (scope !== "all" ? u.userId : undefined);

    if (scope !== "all" && targetUserId !== u.userId) {
      throw new ForbiddenException("Not authorized to view other users' regularizations.");
    }

    const pageSize = Math.min(query.limit ?? 20, 100);
    const offset = ((query.page ?? 1) - 1) * pageSize;

    const conditions = [eq(hrAttendanceRegularizations.orgId, u.orgId)];
    if (targetUserId) conditions.push(eq(hrAttendanceRegularizations.userId, targetUserId));
    if (query.status) conditions.push(eq(hrAttendanceRegularizations.status, query.status));
    if (query.startDate) conditions.push(gte(hrAttendanceRegularizations.attendanceDate, query.startDate));
    if (query.endDate) conditions.push(lte(hrAttendanceRegularizations.attendanceDate, query.endDate));

    const rows = await this.db.query.hrAttendanceRegularizations.findMany({
      where: and(...conditions),
      orderBy: [desc(hrAttendanceRegularizations.createdAt)],
      limit: pageSize,
      offset,
    });

    return { data: rows, page: query.page ?? 1, limit: pageSize };
  }

  async apply(u: CurrentUserContext, regularizationId: number) {
    const scope = await resolveAttendanceScope(this.access, u);
    if (scope !== "all") throw new ForbiddenException("Only managers can apply regularizations.");

    const reg = await this.db.query.hrAttendanceRegularizations.findFirst({
      where: and(
        eq(hrAttendanceRegularizations.id, regularizationId),
        eq(hrAttendanceRegularizations.orgId, u.orgId),
      ),
    });

    if (!reg) throw new NotFoundException("Regularization not found.");
    if (reg.status !== "PENDING") {
      throw new BadRequestException(`Regularization is already ${reg.status}.`);
    }

    await this.db.transaction(async (tx) => {
      if (reg.attendanceId) {
        const updateSet: Record<string, unknown> = {
          status: "PRESENT",
        };
        if (reg.requestedCheckIn) updateSet["checkIn"] = reg.requestedCheckIn;
        if (reg.requestedCheckOut) updateSet["checkOut"] = reg.requestedCheckOut;

        await tx
          .update(attendance)
          .set(updateSet)
          .where(and(eq(attendance.id, reg.attendanceId), eq(attendance.orgId, u.orgId)));
      } else if (reg.requestedCheckIn) {
        await tx.insert(attendance).values({
          orgId: u.orgId,
          userId: reg.userId,
          date: reg.attendanceDate,
          checkIn: reg.requestedCheckIn,
          checkOut: reg.requestedCheckOut ?? null,
          status: "PRESENT",
        });
      }

      await tx
        .update(hrAttendanceRegularizations)
        .set({
          status: "APPROVED",
          approvedBy: u.userId,
          approvedAt: new Date(),
        })
        .where(eq(hrAttendanceRegularizations.id, regularizationId));
    });

    const monthKey = reg.attendanceDate.slice(0, 7);

    this.audit.log({
      action: "hr.attendance_regularization.approved",
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(regularizationId),
      targetType: "attendance_regularization",
      metadata: {
        employeeUserId: reg.userId,
        attendanceDate: reg.attendanceDate,
        monthKey,
        feedsPayrollInputRebuild: true,
      },
    });

    try {
      const rebuild = await this.payrollInputs.rebuildOpenPeriodForMonth(
        u.orgId,
        u.userId,
        monthKey,
      );
      return { success: true, monthKey, payrollInputRebuild: rebuild };
    } catch (err) {
      logger.warn("payroll input rebuild after regularization failed", {
        orgId: u.orgId,
        monthKey,
        regularizationId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        success: true,
        monthKey,
        payrollInputRebuild: { rebuilt: false, periodId: null, status: "error" },
      };
    }
  }

  async reject(u: CurrentUserContext, regularizationId: number, rejectionReason: string) {
    const scope = await resolveAttendanceScope(this.access, u);
    if (scope !== "all") throw new ForbiddenException("Only managers can reject regularizations.");

    const reg = await this.db.query.hrAttendanceRegularizations.findFirst({
      where: and(
        eq(hrAttendanceRegularizations.id, regularizationId),
        eq(hrAttendanceRegularizations.orgId, u.orgId),
      ),
    });

    if (!reg) throw new NotFoundException("Regularization not found.");
    if (reg.status !== "PENDING") {
      throw new BadRequestException(`Regularization is already ${reg.status}.`);
    }

    await this.db
      .update(hrAttendanceRegularizations)
      .set({
        status: "REJECTED",
        rejectedBy: u.userId,
        rejectedAt: new Date(),
        rejectionReason,
      })
      .where(and(eq(hrAttendanceRegularizations.id, regularizationId), eq(hrAttendanceRegularizations.orgId, u.orgId)));

    return { success: true };
  }
}
