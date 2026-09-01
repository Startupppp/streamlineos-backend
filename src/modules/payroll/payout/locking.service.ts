import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../common/organization/organization-actor";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollRuns,
  payrollRunEmployees,
  payrollRunEvents,
  payrollTdsYtdLedger,
} from "../../../db/schema";
import { canTransitionRun } from "../payroll.types";
import type { CalculationSnapshot } from "../payroll.types";
import { AuditService } from "../../../common/audit/audit.service";
import { GenerateService } from "../runs/generate.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { toPaise } from "../runs/lib/money";
import { payrollSubjectKeyFromRunEmployee } from "../lib/payroll-subject";
import { PAYROLL_READ_CAP, requirePayrollReadWithinCap } from "../lib/query-bounds";
import { PAYROLL_RUN_POSTING_INTENT_EVENT } from "./payroll-posting-intent.consumer";

function fiscalYearFromMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const year = y!;
  const mon = m!;
  // India FY: Apr–Mar
  if (mon >= 4) return `${year}-${String(year + 1).slice(2)}`;
  return `${year - 1}-${String(year).slice(2)}`;
}

@Injectable()
export class LockingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly generate: GenerateService,
  ) {}

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

    const lockActor = await assertOrganizationActor(this.db, orgId, { kind: "user", userId }).catch((e: unknown) => {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    });

    const now = new Date();

    await this.db.transaction(async (tx) => {
      const missingSnapshot = await tx.query.payrollRunEmployees.findFirst({
        where: and(
          eq(payrollRunEmployees.runId, runId),
          eq(payrollRunEmployees.orgId, orgId),
          isNull(payrollRunEmployees.calculationSnapshot),
        ),
        columns: { id: true, userId: true, workerId: true },
      });

      if (missingSnapshot) {
        throw new BadRequestException(
          `Payee ${payrollSubjectKeyFromRunEmployee(missingSnapshot)} has no calculation snapshot — re-run generation before locking`,
        );
      }

      await tx
        .update(payrollRuns)
        .set({ status: "LOCKED", lockedAt: now, lockedBy: userId, lockedByMembershipId: lockActor.membershipId, postingState: "pending" })
        .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)));

      await tx.insert(payrollRunEvents).values({
        orgId,
        runId,
        type: "LOCKED",
        actorId: userId,
      });

      await this.generate.postPayrollLock(orgId, runId, tx);
      await this.writeTdsYtdLedger(tx, orgId, runId, run.month);
      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "payroll_run",
        aggregateId: String(runId),
        aggregateVersion: 1,
        eventType: PAYROLL_RUN_POSTING_INTENT_EVENT,
        payload: {
          runId,
          month: run.month,
          gross: run.grossTotal ?? "0",
          deductions: run.deductionTotal ?? "0",
          net: run.netTotal ?? "0",
          employerCost: run.employerCostTotal ?? "0",
          actorUserId: userId,
          orgId,
        },
        occurredAt: now,
      });
    });

    this.audit.log({
      action: "payroll.run_locked",
      userId,
      orgId,
      targetId: String(runId),
      targetType: "payroll_run",
      metadata: { month: run.month },
    });

    return { success: true, lockedAt: now };
  }

  /**
   * Persist per-employee TDS YTD ledger rows from locked calculation snapshots.
   * Safe / idempotent via unique (org, user, fy, periodKey).
   */
  private async writeTdsYtdLedger(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    orgId: string,
    runId: number,
    month: string,
  ): Promise<void> {
    const fy = fiscalYearFromMonth(month);
    const emps = requirePayrollReadWithinCap(await tx
      .select({
        userId: payrollRunEmployees.userId,
        workerId: payrollRunEmployees.workerId,
        calculationSnapshot: payrollRunEmployees.calculationSnapshot,
        gross: payrollRunEmployees.gross,
      })
      .from(payrollRunEmployees)
      .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId)))
      .limit(PAYROLL_READ_CAP + 1), "write TDS ledger");

    for (const emp of emps) {
      if (!emp.userId && !emp.workerId) continue;
      const snap = emp.calculationSnapshot as CalculationSnapshot | null;
      const tdsLine = snap?.lines?.find(
        (l) =>
          l.code === "TDS" ||
          l.code === "INCOME_TAX" ||
          l.category === "TAX",
      );
      const tdsPaise = tdsLine ? toPaise(tdsLine.amount) : 0;
      const taxablePaise = toPaise(emp.gross ?? "0");

      if (emp.userId) {
        await tx
          .insert(payrollTdsYtdLedger)
          .values({
            orgId,
            userId: emp.userId,
            workerId: emp.workerId,
            fiscalYear: fy,
            periodKey: month,
            runId,
            taxableIncomePaise: taxablePaise,
            tdsPaise,
            previousEmployerIncomePaise: 0,
            previousEmployerTdsPaise: 0,
            perquisitesPaise: 0,
            surchargePaise: 0,
            rebatePaise: 0,
          })
          .onConflictDoUpdate({
            target: [
              payrollTdsYtdLedger.orgId,
              payrollTdsYtdLedger.userId,
              payrollTdsYtdLedger.fiscalYear,
              payrollTdsYtdLedger.periodKey,
            ],
            set: {
              runId,
              taxableIncomePaise: taxablePaise,
              tdsPaise,
              workerId: emp.workerId,
            },
          });
        continue;
      }

      if (emp.workerId) {
        await tx
          .insert(payrollTdsYtdLedger)
          .values({
            orgId,
            userId: null,
            workerId: emp.workerId,
            fiscalYear: fy,
            periodKey: month,
            runId,
            taxableIncomePaise: taxablePaise,
            tdsPaise,
            previousEmployerIncomePaise: 0,
            previousEmployerTdsPaise: 0,
            perquisitesPaise: 0,
            surchargePaise: 0,
            rebatePaise: 0,
          })
          .onConflictDoUpdate({
            target: [
              payrollTdsYtdLedger.orgId,
              payrollTdsYtdLedger.workerId,
              payrollTdsYtdLedger.fiscalYear,
              payrollTdsYtdLedger.periodKey,
            ],
            set: {
              runId,
              taxableIncomePaise: taxablePaise,
              tdsPaise,
            },
          });
      }
    }
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

    const reopenActor = await assertOrganizationActor(this.db, orgId, { kind: "user", userId }).catch((e: unknown) => {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    });

    const now = new Date();

    await this.db.transaction(async (tx) => {
      await tx
        .update(payrollRuns)
        .set({ status: "REOPENED", reopenedAt: now, reopenedBy: userId, reopenedByMembershipId: reopenActor.membershipId, reopenReason: reason })
        .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)));

      await tx.insert(payrollRunEvents).values({
        orgId,
        runId,
        type: "REOPENED",
        actorId: userId,
        reason,
      });
    });

    this.audit.log({
      action: "payroll.run_reopened",
      userId,
      orgId,
      targetId: String(runId),
      targetType: "payroll_run",
      metadata: { month: run.month, reason },
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

    const closeActor = await assertOrganizationActor(this.db, orgId, { kind: "user", userId }).catch((e: unknown) => {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    });

    const now = new Date();

    await this.db.transaction(async (tx) => {
      await tx
        .update(payrollRuns)
        .set({ status: "CLOSED", closedAt: now, closedBy: userId, closedByMembershipId: closeActor.membershipId })
        .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)));

      await tx.insert(payrollRunEvents).values({
        orgId,
        runId,
        type: "CLOSED",
        actorId: userId,
      });
    });

    this.audit.log({
      action: "payroll.run_closed",
      userId,
      orgId,
      targetId: String(runId),
      targetType: "payroll_run",
      metadata: { month: run.month },
    });

    return { success: true, closedAt: now };
  }
}
