import { Injectable, Inject } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  organizationMembers,
  payrollInputs,
  payrollRuns,
  payrollRunEvents,
} from "../../../db/schema";
import type { PatchInputInput, InputsQuery } from "./dto/runs.schemas";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import { pullAttendanceInputsByUser } from "./lib/input-puller";
import {
  PAYROLL_READ_CAP,
  requirePayrollReadWithinCap,
} from "../lib/query-bounds";
import type { ScopedRead } from "../../access/scoped-read";
import { listPayrollInputs } from "./list-payroll-inputs";

@Injectable()
export class InputsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listInputs(
    read: ScopedRead,
    runId: number,
    query: InputsQuery,
    actorMembershipId: number | null,
  ) {
    return listPayrollInputs(this.db, read, runId, query, actorMembershipId);
  }

  async patchInput(
    orgId: string,
    runId: number,
    inputId: number,
    actorId: string,
    body: PatchInputInput,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const runCheck = await this.db
      .select({ id: payrollRuns.id, status: payrollRuns.status })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!runCheck[0]) return { ok: false, reason: "not_found" };
    if (PAYROLL_LOCKED_STATUSES.includes(runCheck[0].status))
      return { ok: false, reason: "locked" };

    const input = await this.db
      .select({ id: payrollInputs.id })
      .from(payrollInputs)
      .where(
        and(
          eq(payrollInputs.id, inputId),
          eq(payrollInputs.runId, runId),
          eq(payrollInputs.orgId, orgId),
        ),
      )
      .limit(1);

    if (!input[0]) return { ok: false, reason: "input_not_found" };

    const updateData: Partial<typeof payrollInputs.$inferInsert> = {
      isOverride: true,
      overriddenBy: actorId,
      overrideReason: body.reason,
    };
    if (body.scheduledDays !== undefined)
      updateData.scheduledDays = body.scheduledDays;
    if (body.paidDays !== undefined) updateData.paidDays = body.paidDays;
    if (body.lopDays !== undefined) updateData.lopDays = body.lopDays;
    if (body.overtimeHours !== undefined)
      updateData.overtimeHours = body.overtimeHours;
    if (body.billableHours !== undefined)
      updateData.billableHours = body.billableHours;

    await this.db
      .update(payrollInputs)
      .set(updateData)
      .where(
        and(eq(payrollInputs.id, inputId), eq(payrollInputs.orgId, orgId)),
      );

    await this.db.insert(payrollRunEvents).values({
      orgId,
      runId,
      type: "INPUT_OVERRIDDEN",
      actorId,
      metadata: { inputId, reason: body.reason },
    });

    return { ok: true };
  }

  async reimportInputs(
    orgId: string,
    runId: number,
    actorId: string,
    targetUserId?: string,
  ): Promise<{ ok: true; count: number } | { ok: false; reason: string }> {
    const runCheck = await this.db
      .select({
        id: payrollRuns.id,
        status: payrollRuns.status,
        month: payrollRuns.month,
      })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!runCheck[0]) return { ok: false, reason: "not_found" };
    if (PAYROLL_LOCKED_STATUSES.includes(runCheck[0].status))
      return { ok: false, reason: "locked" };

    const month = runCheck[0].month;

    const conditions = [
      eq(payrollInputs.runId, runId),
      eq(payrollInputs.orgId, orgId),
      eq(payrollInputs.isOverride, false),
    ];
    if (targetUserId) conditions.push(eq(payrollInputs.userId, targetUserId));

    const toReset = requirePayrollReadWithinCap(
      await this.db
        .select({ id: payrollInputs.id, userId: payrollInputs.userId })
        .from(payrollInputs)
        .where(and(...conditions))
        .limit(PAYROLL_READ_CAP + 1),
      "Payroll input reimport",
    );

    if (toReset.length === 0) return { ok: true, count: 0 };

    const idsToDelete = toReset.map((r) => r.id);

    const pulledByUser = await pullAttendanceInputsByUser(
      this.db,
      orgId,
      toReset.map((row) => row.userId),
      month,
    );
    const pulledInputs = toReset.flatMap(({ userId }) => {
      const pulled = pulledByUser.get(userId);
      return pulled ? [{ userId, pulled }] : [];
    });

    const uniqueUserIds = [...new Set(pulledInputs.map((p) => p.userId))];
    const membershipRows =
      uniqueUserIds.length > 0
        ? await this.db
            .select({
              userId: organizationMembers.userId,
              id: organizationMembers.id,
            })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                inArray(organizationMembers.userId, uniqueUserIds),
              ),
            )
            .limit(uniqueUserIds.length + 1)
        : [];
    const memberIdByUserId = new Map<string, number>(
      membershipRows.flatMap((r) =>
        r.userId != null ? [[r.userId, r.id]] : [],
      ),
    );

    const insertRows = pulledInputs.map(({ userId, pulled }) => ({
      orgId,
      runId,
      userId,
      userMembershipId: memberIdByUserId.get(userId),
      source: pulled.source,
      scheduledDays: pulled.scheduledDays,
      paidDays: pulled.paidDays,
      lopDays: pulled.lopDays,
      halfDays: pulled.halfDays,
      overtimeHours: pulled.overtimeHours,
      shiftAllowanceUnits: pulled.shiftAllowanceUnits,
      holidayWorkDays: pulled.holidayWorkDays,
      billableHours: pulled.billableHours,
      isOverride: false,
    }));

    await this.db.transaction(async (tx) => {
      await tx
        .delete(payrollInputs)
        .where(
          and(
            eq(payrollInputs.orgId, orgId),
            inArray(payrollInputs.id, idsToDelete),
          ),
        );

      // One statement: PAYROLL_READ_CAP rows x 15 columns stays far under the
      // 65535 bind-parameter ceiling, so raising that cap needs chunking here.
      if (insertRows.length > 0) {
        await tx
          .insert(payrollInputs)
          .values(insertRows)
          .onConflictDoUpdate({
            target: [payrollInputs.runId, payrollInputs.userId],
            set: {
              source: sql`excluded.source`,
              scheduledDays: sql`excluded.scheduled_days`,
              paidDays: sql`excluded.paid_days`,
              lopDays: sql`excluded.lop_days`,
              halfDays: sql`excluded.half_days`,
              overtimeHours: sql`excluded.overtime_hours`,
              shiftAllowanceUnits: sql`excluded.shift_allowance_units`,
              holidayWorkDays: sql`excluded.holiday_work_days`,
              billableHours: sql`excluded.billable_hours`,
              isOverride: sql`excluded.is_override`,
              overrideReason: sql`null`,
              overriddenBy: sql`null`,
            },
          });
      }

      await tx.insert(payrollRunEvents).values({
        orgId,
        runId,
        type: "INPUT_OVERRIDDEN",
        actorId,
        metadata: { reimport: true, count: toReset.length },
      });
    });

    return { ok: true, count: toReset.length };
  }
}
