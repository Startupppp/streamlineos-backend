import { Injectable, Inject } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollInputs, payrollRuns, payrollRunEvents } from "../../../db/schema";
import { users } from "../../../db/schema";
import type { PatchInputInput, InputsQuery } from "./dto/runs.schemas";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";

@Injectable()
export class InputsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listInputs(orgId: string, runId: number, query: InputsQuery) {
    const runCheck = await this.db
      .select({ id: payrollRuns.id, status: payrollRuns.status })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!runCheck[0]) return null;

    const conditions = [eq(payrollInputs.runId, runId), eq(payrollInputs.orgId, orgId)];
    if (query.userId) conditions.push(eq(payrollInputs.userId, query.userId));

    const rows = await this.db
      .select({
        id: payrollInputs.id,
        userId: payrollInputs.userId,
        source: payrollInputs.source,
        scheduledDays: payrollInputs.scheduledDays,
        paidDays: payrollInputs.paidDays,
        lopDays: payrollInputs.lopDays,
        halfDays: payrollInputs.halfDays,
        overtimeHours: payrollInputs.overtimeHours,
        shiftAllowanceUnits: payrollInputs.shiftAllowanceUnits,
        holidayWorkDays: payrollInputs.holidayWorkDays,
        billableHours: payrollInputs.billableHours,
        isOverride: payrollInputs.isOverride,
        overrideReason: payrollInputs.overrideReason,
        createdAt: payrollInputs.createdAt,
        userName: users.name,
        userEmail: users.email,
      })
      .from(payrollInputs)
      .innerJoin(users, eq(users.id, payrollInputs.userId))
      .where(and(...conditions))
      .orderBy(users.name);

    return rows;
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
    if (PAYROLL_LOCKED_STATUSES.includes(runCheck[0].status)) return { ok: false, reason: "locked" };

    const input = await this.db
      .select({ id: payrollInputs.id })
      .from(payrollInputs)
      .where(and(eq(payrollInputs.id, inputId), eq(payrollInputs.runId, runId), eq(payrollInputs.orgId, orgId)))
      .limit(1);

    if (!input[0]) return { ok: false, reason: "input_not_found" };

    const updateData: Partial<typeof payrollInputs.$inferInsert> = {
      isOverride: true,
      overriddenBy: actorId,
      overrideReason: body.reason,
    };
    if (body.scheduledDays !== undefined) updateData.scheduledDays = body.scheduledDays;
    if (body.paidDays !== undefined) updateData.paidDays = body.paidDays;
    if (body.lopDays !== undefined) updateData.lopDays = body.lopDays;
    if (body.overtimeHours !== undefined) updateData.overtimeHours = body.overtimeHours;

    await this.db.update(payrollInputs).set(updateData).where(eq(payrollInputs.id, inputId));

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
      .select({ id: payrollRuns.id, status: payrollRuns.status, month: payrollRuns.month })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!runCheck[0]) return { ok: false, reason: "not_found" };
    if (PAYROLL_LOCKED_STATUSES.includes(runCheck[0].status)) return { ok: false, reason: "locked" };

    const conditions = [eq(payrollInputs.runId, runId), eq(payrollInputs.orgId, orgId), eq(payrollInputs.isOverride, false)];
    if (targetUserId) conditions.push(eq(payrollInputs.userId, targetUserId));

    const toReset = await this.db
      .select({ id: payrollInputs.id })
      .from(payrollInputs)
      .where(and(...conditions));

    return { ok: true, count: toReset.length };
  }
}
