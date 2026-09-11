import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import {
  payrollBankBatches,
  payrollBankBatchItems,
  payrollRunEmployees,
} from "../../../../db/schema";
import { PAYROLL_READ_CAP, requirePayrollReadWithinCap } from "../../lib/query-bounds";
import { fromPaise } from "../../runs/lib/money";

/** What a finished run settled, once every payee it owes has been paid. */
export interface RunCoverage {
  /** Run employees carrying a PAID bank instruction. */
  paidRunEmployeeIds: number[];
  /** Run payees owed money and not on hold — the set a finished run must cover. */
  payableSubjects: number;
  /**
   * MONEY: rupees in `numeric(15,2)` wire format — the base-currency net of the
   * payees that actually settled. This, not `payrollRuns.netTotal`, is what
   * accounting is told to discharge: the run total still carries anyone held,
   * and posting it credits BANK_CLEARING for money the bank never moved while
   * writing off a payable that is still owed.
   */
  disbursedNet: string;
}

/**
 * Decides whether a run is finished, and what it disbursed if so.
 *
 * Two conditions, and the second is the one that was missing. Every bank
 * instruction on the run must have settled — and those settled payees must
 * cover the run's whole payable set. `batch-creator.service.ts:113-120` never
 * batches everyone: it drops payees an operator held, payees with no bank
 * account and payees owed nothing. Measuring coverage over batched payees alone
 * therefore read "every instruction settled" as "every payee paid", so a payee
 * who never reached a batch still left the run marked PAID.
 *
 * A hold is a deliberate exclusion and does not block completion; a payee who
 * is owed money and is not held does.
 *
 * Returns `null` while the run is not finished.
 */
export async function resolveRunCoverage(
  db: Db,
  orgId: string,
  runId: number,
): Promise<RunCoverage | null> {
  const allBatches = requirePayrollReadWithinCap(
    await db
      .select({ id: payrollBankBatches.id })
      .from(payrollBankBatches)
      .where(and(eq(payrollBankBatches.orgId, orgId), eq(payrollBankBatches.runId, runId)))
      .limit(PAYROLL_READ_CAP + 1),
    "load payout batches for run completion",
  );

  const batchIds = allBatches.map((b) => b.id);
  if (batchIds.length === 0) return null;

  const [coverage] = await db
    .select({
      subjects: sql<number>`count(distinct ${payrollBankBatchItems.runEmployeeId})::int`,
      paidSubjects: sql<number>`count(distinct ${payrollBankBatchItems.runEmployeeId}) filter (where ${payrollBankBatchItems.status} = 'PAID')::int`,
    })
    .from(payrollBankBatchItems)
    .where(
      and(
        eq(payrollBankBatchItems.orgId, orgId),
        inArray(payrollBankBatchItems.batchId, batchIds),
      ),
    );

  const subjects = coverage?.subjects ?? 0;
  const paidSubjects = coverage?.paidSubjects ?? 0;
  if (subjects === 0 || paidSubjects !== subjects) return null;

  const [runCoverage] = await db
    .select({ payable: sql<number>`count(*)::int` })
    .from(payrollRunEmployees)
    .where(
      and(
        eq(payrollRunEmployees.orgId, orgId),
        eq(payrollRunEmployees.runId, runId),
        ne(payrollRunEmployees.status, "HELD"),
        isNull(payrollRunEmployees.holdReason),
        // Rupees, numeric(15,2): payout currency where one is set, base
        // otherwise — the same amount batch-creator tests for eligibility.
        sql`coalesce(${payrollRunEmployees.netPayoutCurrency}, ${payrollRunEmployees.net}) > 0`,
      ),
    );

  const payableSubjects = runCoverage?.payable ?? 0;
  if (payableSubjects === 0 || paidSubjects !== payableSubjects) return null;

  const paidRunEmployees = requirePayrollReadWithinCap(
    await db
      .select({ runEmployeeId: payrollBankBatchItems.runEmployeeId })
      .from(payrollBankBatchItems)
      .where(
        and(
          eq(payrollBankBatchItems.orgId, orgId),
          inArray(payrollBankBatchItems.batchId, batchIds),
          eq(payrollBankBatchItems.status, "PAID"),
        ),
      )
      .limit(PAYROLL_READ_CAP + 1),
    "load paid payout instructions for run completion",
  );

  const paidRunEmployeeIds = paidRunEmployees.map((r) => r.runEmployeeId);

  // MONEY: summed as integer paise inside Postgres — no float holds a running
  // total — and converted to the rupee wire format once, here at the edge.
  const [disbursed] =
    paidRunEmployeeIds.length === 0
      ? [{ totalPaise: "0" }]
      : await db
          .select({
            totalPaise: sql<string>`coalesce(sum(round(${payrollRunEmployees.net} * 100)), 0)::text`,
          })
          .from(payrollRunEmployees)
          .where(
            and(
              eq(payrollRunEmployees.orgId, orgId),
              eq(payrollRunEmployees.runId, runId),
              inArray(payrollRunEmployees.id, paidRunEmployeeIds),
            ),
          );

  return {
    paidRunEmployeeIds,
    payableSubjects,
    disbursedNet: fromPaise(Number(disbursed?.totalPaise ?? "0")),
  };
}
