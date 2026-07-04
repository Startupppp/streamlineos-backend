import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollRuns, payrollRunEmployees, payrollRunEvents } from "../../../db/schema";
import { canTransitionRun } from "../payroll.types";

@Injectable()
export class LockingService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async lock(orgId: string, userId: string, runId: number) {
    const run = await this.db.query.payrollRuns.findFirst({
      where: and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)),
    });

    if (!run) {
      throw new NotFoundException("Payroll run not found");
    }

    if (!canTransitionRun(run.status, "LOCKED")) {
      throw new ConflictException(`Cannot lock run in status ${run.status}`);
    }

    const now = new Date();

    await this.db.transaction(async (tx) => {
      const missingSnapshot = await tx.query.payrollRunEmployees.findFirst({
        where: and(
          eq(payrollRunEmployees.runId, runId),
          eq(payrollRunEmployees.orgId, orgId),
          isNull(payrollRunEmployees.calculationSnapshot),
        ),
        columns: { id: true, userId: true },
      });

      if (missingSnapshot) {
        throw new BadRequestException(
          `Employee ${missingSnapshot.userId} has no calculation snapshot — re-run generation before locking`,
        );
      }

      await tx
        .update(payrollRuns)
        .set({ status: "LOCKED", lockedAt: now, lockedBy: userId })
        .where(eq(payrollRuns.id, runId));

      await tx.insert(payrollRunEvents).values({
        orgId,
        runId,
        type: "LOCKED",
        actorId: userId,
      });
    });

    return { success: true, lockedAt: now };
  }

  async reopen(orgId: string, userId: string, runId: number, reason: string) {
    const run = await this.db.query.payrollRuns.findFirst({
      where: and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)),
    });

    if (!run) {
      throw new NotFoundException("Payroll run not found");
    }

    if (!canTransitionRun(run.status, "REOPENED")) {
      throw new ConflictException(`Cannot reopen run in status ${run.status}`);
    }

    const now = new Date();

    await this.db.transaction(async (tx) => {
      await tx
        .update(payrollRuns)
        .set({ status: "REOPENED", reopenedAt: now, reopenedBy: userId, reopenReason: reason })
        .where(eq(payrollRuns.id, runId));

      await tx.insert(payrollRunEvents).values({
        orgId,
        runId,
        type: "REOPENED",
        actorId: userId,
        reason,
      });
    });

    return { success: true, reopenedAt: now };
  }

  async close(orgId: string, userId: string, runId: number) {
    const run = await this.db.query.payrollRuns.findFirst({
      where: and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)),
    });

    if (!run) {
      throw new NotFoundException("Payroll run not found");
    }

    if (!canTransitionRun(run.status, "CLOSED")) {
      throw new ConflictException(`Cannot close run in status ${run.status}`);
    }

    const now = new Date();

    await this.db.transaction(async (tx) => {
      await tx
        .update(payrollRuns)
        .set({ status: "CLOSED", closedAt: now, closedBy: userId })
        .where(eq(payrollRuns.id, runId));

      await tx.insert(payrollRunEvents).values({
        orgId,
        runId,
        type: "CLOSED",
        actorId: userId,
      });
    });

    return { success: true, closedAt: now };
  }
}
