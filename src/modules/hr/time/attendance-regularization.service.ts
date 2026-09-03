import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { attendance, hrAttendanceRegularizations } from "../../../db/schema";
import { PayrollInputsService } from "../payroll-inputs/payroll-inputs.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { HrWorkflowEngineService } from "../workflows/hr-workflow-engine.service";
import { AccessService } from "../../access/access.service";
import { resolveAttendanceScope } from "./attendance-scope";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { AuditService } from "../../../common/audit/audit.service";
import { requireOrganizationMembershipId } from "./organization-membership";

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

    const membershipId = actingMembershipId(u.principal);
    if (membershipId == null) {
      throw new ForbiddenException("Organization membership required.");
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`${u.orgId}:${u.userId}:${input.attendanceDate}:regularization`}, 0)
        )
      `);

      const existingPending = await tx.query.hrAttendanceRegularizations.findFirst({
        columns: { id: true },
        where: and(
          eq(hrAttendanceRegularizations.orgId, u.orgId),
          eq(hrAttendanceRegularizations.userMembershipId, membershipId),
          eq(hrAttendanceRegularizations.attendanceDate, input.attendanceDate),
          eq(hrAttendanceRegularizations.status, "PENDING"),
        ),
      });
      if (existingPending) {
        throw new BadRequestException("A pending regularization already exists for this date.");
      }

      const attendanceRow = await tx.query.attendance.findFirst({
        where: and(
          eq(attendance.orgId, u.orgId),
          eq(attendance.userMembershipId, membershipId),
          eq(attendance.date, input.attendanceDate),
        ),
      });
      const [regularization] = await tx
        .insert(hrAttendanceRegularizations)
        .values({
          orgId: u.orgId,
          userId: u.userId,
          userMembershipId: membershipId,
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
        tx,
      });
      if (!instance) throw new BadRequestException("Failed to start regularization workflow.");

      const workflowInstanceId = String(instance.id);
      await tx
        .update(hrAttendanceRegularizations)
        .set({ workflowInstanceId })
        .where(
          and(
            eq(hrAttendanceRegularizations.id, regularization.id),
            eq(hrAttendanceRegularizations.orgId, u.orgId),
            eq(hrAttendanceRegularizations.status, "PENDING"),
          ),
        );
      return { ...regularization, workflowInstanceId };
    });
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
    if (targetUserId) {
      const targetMembershipId = targetUserId === u.userId
        ? actingMembershipId(u.principal)
        : await requireOrganizationMembershipId(this.db, u.orgId, targetUserId);
      if (targetMembershipId == null) throw new ForbiddenException("Organization membership required.");
      conditions.push(eq(hrAttendanceRegularizations.userMembershipId, targetMembershipId));
    }
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
    const membershipId = actingMembershipId(u.principal);
    if (membershipId == null) throw new ForbiddenException("Organization membership required.");

    const applied = await this.db.transaction(async (tx) => {
      const [reg] = await tx
        .select()
        .from(hrAttendanceRegularizations)
        .where(
          and(
            eq(hrAttendanceRegularizations.id, regularizationId),
            eq(hrAttendanceRegularizations.orgId, u.orgId),
          ),
        )
        .limit(1)
        .for("update");
      if (!reg) throw new NotFoundException("Regularization not found.");
      if (reg.status !== "PENDING") {
        throw new BadRequestException(`Regularization is already ${reg.status}.`);
      }

      let originalCheckIn: Date | null = null;
      let originalCheckOut: Date | null = null;
      if (reg.attendanceId) {
        const [original] = await tx
          .select({ checkIn: attendance.checkIn, checkOut: attendance.checkOut })
          .from(attendance)
          .where(and(eq(attendance.id, reg.attendanceId), eq(attendance.orgId, u.orgId)))
          .limit(1)
          .for("update");
        if (!original) throw new ConflictException("The linked attendance record no longer exists.");
        originalCheckIn = original.checkIn;
        originalCheckOut = original.checkOut;

        const checkIn = reg.requestedCheckIn ?? original.checkIn;
        const checkOut = reg.requestedCheckOut ?? original.checkOut;
        const workHours = this.workHours(checkIn, checkOut);

        await tx
          .update(attendance)
          .set({
            checkIn,
            checkOut,
            workHours,
            status: checkOut ? "CHECKED_OUT" : "PRESENT",
          })
          .where(and(eq(attendance.id, reg.attendanceId), eq(attendance.orgId, u.orgId)));
      } else if (reg.requestedCheckIn) {
        const workHours = this.workHours(reg.requestedCheckIn, reg.requestedCheckOut);
        await tx.insert(attendance).values({
          orgId: u.orgId,
          userId: reg.userId,
          userMembershipId: reg.userMembershipId,
          date: reg.attendanceDate,
          checkIn: reg.requestedCheckIn,
          checkOut: reg.requestedCheckOut ?? null,
          status: reg.requestedCheckOut ? "CHECKED_OUT" : "PRESENT",
          workHours,
        });
      } else {
        throw new BadRequestException("A check-in time is required to create attendance.");
      }

      const changed = await tx
        .update(hrAttendanceRegularizations)
        .set({
          status: "APPROVED",
          approvedByMembershipId: membershipId,
          approvedAt: new Date(),
        })
        .where(
          and(
            eq(hrAttendanceRegularizations.id, regularizationId),
            eq(hrAttendanceRegularizations.orgId, u.orgId),
            eq(hrAttendanceRegularizations.status, "PENDING"),
          ),
        )
        .returning({ id: hrAttendanceRegularizations.id });
      if (changed.length !== 1) {
        throw new ConflictException("This regularization was already decided.");
      }

      const monthKey = reg.attendanceDate.slice(0, 7);
      await this.audit.logCritical({
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
        before: {
          checkIn: originalCheckIn?.toISOString() ?? null,
          checkOut: originalCheckOut?.toISOString() ?? null,
        },
        after: {
          checkIn: reg.requestedCheckIn?.toISOString() ?? originalCheckIn?.toISOString() ?? null,
          checkOut: reg.requestedCheckOut?.toISOString() ?? originalCheckOut?.toISOString() ?? null,
        },
      });
      return { reg, monthKey };
    });

    const rebuild = await this.payrollInputs.rebuildOpenPeriodForMonth(
      u.orgId,
      u.userId,
      applied.monthKey,
    );
    return { success: true, monthKey: applied.monthKey, payrollInputRebuild: rebuild };
  }

  async reject(u: CurrentUserContext, regularizationId: number, rejectionReason: string) {
    const scope = await resolveAttendanceScope(this.access, u);
    if (scope !== "all") throw new ForbiddenException("Only managers can reject regularizations.");
    const membershipId = actingMembershipId(u.principal);
    if (membershipId == null) throw new ForbiddenException("Organization membership required.");

    await this.db.transaction(async (tx) => {
      const [reg] = await tx
        .select({ status: hrAttendanceRegularizations.status })
        .from(hrAttendanceRegularizations)
        .where(
          and(
            eq(hrAttendanceRegularizations.id, regularizationId),
            eq(hrAttendanceRegularizations.orgId, u.orgId),
          ),
        )
        .limit(1)
        .for("update");
      if (!reg) throw new NotFoundException("Regularization not found.");
      if (reg.status !== "PENDING") {
        throw new BadRequestException(`Regularization is already ${reg.status}.`);
      }

      const changed = await tx
        .update(hrAttendanceRegularizations)
        .set({
          status: "REJECTED",
          rejectedByMembershipId: membershipId,
          rejectedAt: new Date(),
          rejectionReason,
        })
        .where(
          and(
            eq(hrAttendanceRegularizations.id, regularizationId),
            eq(hrAttendanceRegularizations.orgId, u.orgId),
            eq(hrAttendanceRegularizations.status, "PENDING"),
          ),
        )
        .returning({ id: hrAttendanceRegularizations.id });
      if (changed.length !== 1) {
        throw new ConflictException("This regularization was already decided.");
      }

      await this.audit.logCritical({
        action: "hr.attendance_regularization.rejected",
        userId: u.userId,
        orgId: u.orgId,
        targetId: String(regularizationId),
        targetType: "attendance_regularization",
        metadata: { rejectionReason },
      });
    });

    return { success: true };
  }

  private workHours(checkIn: Date | null, checkOut: Date | null): string | null {
    if (!checkIn || !checkOut) return null;
    if (checkOut <= checkIn) {
      throw new BadRequestException("Check-out must be after check-in.");
    }
    return ((checkOut.getTime() - checkIn.getTime()) / 3_600_000).toFixed(2);
  }
}
