import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
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
import { canTransitionRun, toCalculationSnapshot } from "../payroll.types";
import type { PayrollRunStatus } from "../payroll.types";
import { AuditService } from "../../../common/audit/audit.service";
import { GenerateService } from "../runs/generate.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { toPaise } from "../runs/lib/money";
import { payrollSubjectKeyFromRunEmployee } from "../lib/payroll-subject";
import {
  PAYROLL_READ_CAP,
  requirePayrollReadWithinCap,
} from "../lib/query-bounds";
import { PAYROLL_RUN_POSTING_INTENT_EVENT } from "./payroll-posting-intent.consumer";

export type PayrollLockTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type TdsLedgerInsert = typeof payrollTdsYtdLedger.$inferInsert;

export interface LockCommitRun {
  month: string;
  status: PayrollRunStatus;
  grossTotal: string | null;
  deductionTotal: string | null;
  netTotal: string | null;
  employerCostTotal: string | null;
}

export interface LockCommitInput {
  orgId: string;
  userId: string;
  runId: number;
  run: LockCommitRun;
  membershipId: number | null;
  now: Date;
  alsoMarkApproved: boolean;
}

function fiscalYearFromMonth(month: string): string {
  const [year, mon] = month.split("-").map(Number);
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

    const lockActor = await assertOrganizationActor(this.db, orgId, {
      kind: "user",
      userId,
    }).catch((e: unknown) => {
      if (e instanceof OrganizationActorError)
        throw organizationActorHttpError(e);
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

      await this.commitLock(tx, {
        orgId,
        userId,
        runId,
        run,
        membershipId: lockActor.membershipId,
        now,
        alsoMarkApproved: false,
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
   * The single place a payroll run becomes LOCKED: status guard, run events, snapshot
   * posting, TDS ledger and the Accounting posting intent all commit on the caller's tx.
   */
  async commitLock(tx: PayrollLockTx, input: LockCommitInput): Promise<void> {
    const { orgId, userId, runId, run, membershipId, now } = input;

    const locked = await tx
      .update(payrollRuns)
      .set({
        status: "LOCKED",
        lockedAt: now,
        lockedBy: userId,
        lockedByMembershipId: membershipId,
        postingState: "pending",
        ...(input.alsoMarkApproved
          ? { approvedAt: now, approvedByMembershipId: membershipId }
          : {}),
      })
      .where(
        and(
          eq(payrollRuns.id, runId),
          eq(payrollRuns.orgId, orgId),
          eq(payrollRuns.status, run.status),
        ),
      )
      .returning({ id: payrollRuns.id });
    if (locked.length === 0) {
      throw new ConflictException(
        `Payroll run ${runId} left status ${run.status} before the lock committed`,
      );
    }

    await tx.insert(payrollRunEvents).values(
      input.alsoMarkApproved
        ? [
            { orgId, runId, type: "APPROVED", actorId: userId },
            { orgId, runId, type: "LOCKED", actorId: userId },
          ]
        : [{ orgId, runId, type: "LOCKED", actorId: userId }],
    );

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
  }

  /**
   * Persist per-employee TDS YTD ledger rows from locked calculation snapshots as two
   * bulk upserts — one per subject kind — instead of one round trip per run employee.
   * Both unique indexes are PARTIAL (`WHERE user_id IS NOT NULL` / `WHERE worker_id IS
   * NOT NULL`, migration 0393), so the arbiter is only inferable with a matching
   * `targetWhere`; without it Postgres raises 42P10 and the lock fails outright. The
   * per-subject Maps collapse duplicates in the run before they reach the statement,
   * because a multi-row `ON CONFLICT DO UPDATE` raises 21000 on an intra-statement
   * duplicate rather than keeping the last one the way the per-row loop did.
   *
   * `run_id` is part of both natural keys (migration 1050). Without it the key was
   * (org, subject, fiscal_year, month) and `DO UPDATE` REPLACED taxable_income_paise
   * and tds_paise, so locking a BONUS / OFF_CYCLE / CORRECTION / FINAL_SETTLEMENT run
   * for a month that already had a locked REGULAR run destroyed the regular run's
   * withholding instead of adding to it — the year-to-date total then under-reported
   * every rupee withheld by the earlier run. One row per run makes a fiscal year's
   * withholding the SUM over its rows, which is what a year-to-date ledger means.
   */
  private async writeTdsYtdLedger(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    orgId: string,
    runId: number,
    month: string,
  ): Promise<void> {
    const fy = fiscalYearFromMonth(month);
    const emps = requirePayrollReadWithinCap(
      await tx
        .select({
          userId: payrollRunEmployees.userId,
          workerId: payrollRunEmployees.workerId,
          calculationSnapshot: payrollRunEmployees.calculationSnapshot,
          gross: payrollRunEmployees.gross,
        })
        .from(payrollRunEmployees)
        .where(
          and(
            eq(payrollRunEmployees.runId, runId),
            eq(payrollRunEmployees.orgId, orgId),
          ),
        )
        .limit(PAYROLL_READ_CAP + 1),
      "write TDS ledger",
    );

    const byUser = new Map<string, TdsLedgerInsert>();
    const byWorker = new Map<string, TdsLedgerInsert>();

    for (const emp of emps) {
      if (!emp.userId && !emp.workerId) continue;
      const snap = toCalculationSnapshot(emp.calculationSnapshot);
      const tdsLine = snap?.lines?.find(
        (l) =>
          l.code === "TDS" || l.code === "INCOME_TAX" || l.category === "TAX",
      );
      const base = {
        orgId,
        fiscalYear: fy,
        periodKey: month,
        runId,
        taxableIncomePaise: toPaise(emp.gross ?? "0"),
        tdsPaise: tdsLine ? toPaise(tdsLine.amount) : 0,
        previousEmployerIncomePaise: 0,
        previousEmployerTdsPaise: 0,
        perquisitesPaise: 0,
        surchargePaise: 0,
        rebatePaise: 0,
      };

      if (emp.userId) {
        byUser.set(emp.userId, { ...base, userId: emp.userId, workerId: emp.workerId });
        continue;
      }
      if (emp.workerId)
        byWorker.set(emp.workerId, { ...base, userId: null, workerId: emp.workerId });
    }

    if (byUser.size > 0)
      await tx
        .insert(payrollTdsYtdLedger)
        .values([...byUser.values()])
        .onConflictDoUpdate({
          target: [
            payrollTdsYtdLedger.orgId,
            payrollTdsYtdLedger.userId,
            payrollTdsYtdLedger.fiscalYear,
            payrollTdsYtdLedger.periodKey,
            payrollTdsYtdLedger.runId,
          ],
          targetWhere: sql`${payrollTdsYtdLedger.userId} is not null`,
          set: {
            taxableIncomePaise: sql`excluded.taxable_income_paise`,
            tdsPaise: sql`excluded.tds_paise`,
            workerId: sql`excluded.worker_id`,
          },
        });

    if (byWorker.size > 0)
      await tx
        .insert(payrollTdsYtdLedger)
        .values([...byWorker.values()])
        .onConflictDoUpdate({
          target: [
            payrollTdsYtdLedger.orgId,
            payrollTdsYtdLedger.workerId,
            payrollTdsYtdLedger.fiscalYear,
            payrollTdsYtdLedger.periodKey,
            payrollTdsYtdLedger.runId,
          ],
          targetWhere: sql`${payrollTdsYtdLedger.workerId} is not null`,
          set: {
            taxableIncomePaise: sql`excluded.taxable_income_paise`,
            tdsPaise: sql`excluded.tds_paise`,
          },
        });
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

    const reopenActor = await assertOrganizationActor(this.db, orgId, {
      kind: "user",
      userId,
    }).catch((e: unknown) => {
      if (e instanceof OrganizationActorError)
        throw organizationActorHttpError(e);
      throw e;
    });

    const now = new Date();

    await this.db.transaction(async (tx) => {
      const reopened = await tx
        .update(payrollRuns)
        .set({
          status: "REOPENED",
          reopenedAt: now,
          reopenedBy: userId,
          reopenedByMembershipId: reopenActor.membershipId,
          reopenReason: reason,
        })
        .where(
          and(
            eq(payrollRuns.id, runId),
            eq(payrollRuns.orgId, orgId),
            eq(payrollRuns.status, run.status),
          ),
        )
        .returning({ id: payrollRuns.id });
      if (reopened.length === 0) {
        throw new ConflictException(
          `Payroll run ${runId} left status ${run.status} before the reopen committed`,
        );
      }

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

    const closeActor = await assertOrganizationActor(this.db, orgId, {
      kind: "user",
      userId,
    }).catch((e: unknown) => {
      if (e instanceof OrganizationActorError)
        throw organizationActorHttpError(e);
      throw e;
    });

    const now = new Date();

    await this.db.transaction(async (tx) => {
      const closed = await tx
        .update(payrollRuns)
        .set({
          status: "CLOSED",
          closedAt: now,
          closedBy: userId,
          closedByMembershipId: closeActor.membershipId,
        })
        .where(
          and(
            eq(payrollRuns.id, runId),
            eq(payrollRuns.orgId, orgId),
            eq(payrollRuns.status, run.status),
          ),
        )
        .returning({ id: payrollRuns.id });
      if (closed.length === 0) {
        throw new ConflictException(
          `Payroll run ${runId} left status ${run.status} before the close committed`,
        );
      }

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
