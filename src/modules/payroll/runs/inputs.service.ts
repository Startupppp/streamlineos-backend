import { Injectable, Inject, ForbiddenException } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { organizationMembers, payrollInputs, payrollRuns, payrollRunEvents } from "../../../db/schema";
import { users } from "../../../db/schema";
import type { PatchInputInput, InputsQuery } from "./dto/runs.schemas";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import { pullAttendanceInputs } from "./lib/input-puller";
import type { DataScope } from "../../access/access.types";
import { buildCursorPage } from "../../../common/pagination/cursor";
import {
  decodePayrollTextCursor,
  payrollCursorPosition,
} from "../payroll-cursor";

const inputSortName = sql<string>`coalesce(${users.name}, ${users.email})`;

@Injectable()
export class InputsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listInputs(
    orgId: string,
    runId: number,
    query: InputsQuery,
    scope: DataScope,
    actorUserId: string,
    actorMembershipId: number | null,
  ) {
    const runCheck = await this.db
      .select({ id: payrollRuns.id, status: payrollRuns.status })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!runCheck[0]) return null;

    if (query.userId && query.userId !== actorUserId && scope !== "all") {
      throw new ForbiddenException("Not authorized to filter payroll inputs for another payee");
    }

    if (actorMembershipId == null) throw new ForbiddenException("Organization membership required");
    const conditions = [
      eq(payrollInputs.runId, runId),
      eq(payrollInputs.orgId, orgId),
      scope === "all" ? eq(payrollInputs.orgId, orgId) : eq(payrollInputs.userMembershipId, actorMembershipId),
    ];
    if (query.userId) conditions.push(eq(payrollInputs.userMembershipId, actorMembershipId));

    const limit = Math.min(query.limit ?? 50, 100);
    const cursorScope = [
      "run-inputs",
      orgId,
      runId,
      query.userId ?? null,
      scope,
      actorMembershipId,
    ] as const;
    const position = decodePayrollTextCursor(query.cursor, cursorScope);
    if (position) {
      conditions.push(
        sql`(${inputSortName}, ${payrollInputs.id}) > (${sql.param(position.value)}, ${sql.param(position.id, payrollInputs.id)})`,
      );
    }

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
      .orderBy(asc(inputSortName), asc(payrollInputs.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) =>
      payrollCursorPosition(
        cursorScope,
        [row.userName ?? row.userEmail],
        row.id,
      ),
    );
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
    if (body.billableHours !== undefined) updateData.billableHours = body.billableHours;

    await this.db.update(payrollInputs).set(updateData).where(and(eq(payrollInputs.id, inputId), eq(payrollInputs.orgId, orgId)));

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

    const month = runCheck[0].month;

    const conditions = [
      eq(payrollInputs.runId, runId),
      eq(payrollInputs.orgId, orgId),
      eq(payrollInputs.isOverride, false),
    ];
    if (targetUserId) conditions.push(eq(payrollInputs.userId, targetUserId));

    const toReset = await this.db
      .select({ id: payrollInputs.id, userId: payrollInputs.userId })
      .from(payrollInputs)
      .where(and(...conditions))
      .limit(1000);

    if (toReset.length === 0) return { ok: true, count: 0 };

    const idsToDelete = toReset.map(r => r.id);

    const pulledInputs: Array<{
      userId: string;
      pulled: NonNullable<Awaited<ReturnType<typeof pullAttendanceInputs>>>;
    }> = [];
    for (const row of toReset) {
      const pulled = await pullAttendanceInputs(this.db, orgId, row.userId, month);
      if (pulled) pulledInputs.push({ userId: row.userId, pulled });
    }

    const uniqueUserIds = [...new Set(pulledInputs.map((p) => p.userId))];
    const membershipRows = uniqueUserIds.length > 0
      ? await this.db
          .select({ userId: organizationMembers.userId, id: organizationMembers.id })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, uniqueUserIds)))
          .limit(uniqueUserIds.length + 1)
      : [];
    const memberIdByUserId = new Map<string, number>(
      membershipRows.flatMap((r) => r.userId != null ? [[r.userId, r.id]] : []),
    );

    await this.db.transaction(async (tx) => {
      await tx.delete(payrollInputs).where(inArray(payrollInputs.id, idsToDelete));

      for (const { userId, pulled } of pulledInputs) {
        await tx
          .insert(payrollInputs)
          .values({
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
          })
          .onConflictDoUpdate({
            target: [payrollInputs.runId, payrollInputs.userId],
            set: {
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
              overrideReason: null,
              overriddenBy: null,
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
