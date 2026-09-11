import { Test, type TestingModule } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { PayrollInputsService } from "../payroll-inputs.service";
import { HrAuditService } from "../../core/hr-audit.service";
import { HrAutomationEngineService } from "../../automations/hr-automation-engine.service";
import { PayrollInputsBuildService } from "../payroll-inputs-build.service";
import { PayrollInputSnapshotsService } from "../payroll-input-snapshots.service";
import { getTableName } from "drizzle-orm";
import { hrLeaveLedger } from "../../../../db/schema/hr/leave-ledger";
import { hrLoanRepayments } from "../../../../db/schema/hr/benefits";
import { hrPayrollInputPeriods } from "../../../../db/schema/payroll/input-capture";
import { PG_CHECK_VIOLATION, getPostgresErrorDetails } from "../../../../common/db/postgres-error";

/**
 * Locking a payroll input period freezes the leave ledger and stamps every due
 * loan installment `deducted`, in one transaction with the period's own status
 * flip. Both companion writes carried `.catch(() => undefined)`, so a failure
 * on either left the transaction to COMMIT: the period was audited as locked
 * and immutable while the installments stayed `pending` and were deducted again
 * from the employee's pay the following period. These tests fail the write
 * rather than stub it away, and assert the whole unit is refused.
 */

const CONSTRAINT_FAILURE = "hr_loan_repayments_status_check";

function driverError(message: string, code: string): Error {
  const pg = Object.assign(new Error(message), {
    code,
    constraint_name: CONSTRAINT_FAILURE,
    table_name: "hr_loan_repayments",
    severity: "ERROR",
  });
  return Object.assign(new Error("Failed query: update ..."), { cause: pg });
}

function makePeriod(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    orgId: "org1",
    periodKey: "2026-07",
    status: "built",
    createdBy: "actor1",
    createdAt: new Date(),
    updatedAt: new Date(),
    builtAt: new Date(),
    lockedAt: null,
    lockedBy: null,
    cutoffDate: null,
    ...overrides,
  };
}

interface TxRecorder {
  tx: unknown;
  committed: boolean;
  updatedTables: string[];
}

/**
 * `failOn` names the drizzle table object whose UPDATE rejects. Everything else
 * resolves. `committed` is only set when the service's callback returns without
 * throwing — which is exactly when a real driver would COMMIT.
 */
function makeTx(failOn: unknown | null, dueRepaymentIds: Array<{ id: number }>): TxRecorder {
  const recorder: TxRecorder = { tx: null, committed: false, updatedTables: [] };
  const tx = {
    update: (table: unknown) => {
      recorder.updatedTables.push(getTableName(table as Parameters<typeof getTableName>[0]));
      const rejectHere = failOn !== null && table === failOn;
      const terminal = rejectHere
        ? Promise.reject(driverError("new row violates check constraint", "23514"))
        : Promise.resolve([makePeriod({ status: "locked" })]);
      const chain = {
        set: () => chain,
        where: () => ({
          then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => terminal.then(ok, bad),
          catch: (bad: (e: unknown) => unknown) => terminal.catch(bad),
          returning: () => terminal,
        }),
      };
      return chain;
    },
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(dueRepaymentIds) }) }),
    }),
  };
  recorder.tx = tx;
  return recorder;
}

function makeDb(recorder: TxRecorder, period: ReturnType<typeof makePeriod>) {
  return {
    query: { hrPayrollInputPeriods: { findFirst: jest.fn().mockResolvedValue(period) } },
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const out = await fn(recorder.tx);
      recorder.committed = true;
      return out;
    }),
  };
}

const audit = { log: jest.fn().mockResolvedValue(undefined) };
const automation = { emit: jest.fn().mockResolvedValue(undefined) };
const build = { buildSnapshots: jest.fn().mockResolvedValue(undefined) };
const snapshots = {
  buildFreezeSummary: jest.fn().mockResolvedValue({ sections: {}, employeeCount: 0 }),
  listSectionSnapshot: jest.fn(),
};

async function makeService(db: unknown): Promise<PayrollInputsService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      PayrollInputsService,
      { provide: DRIZZLE, useValue: db },
      { provide: HrAuditService, useValue: audit },
      { provide: HrAutomationEngineService, useValue: automation },
      { provide: PayrollInputsBuildService, useValue: build },
      { provide: PayrollInputSnapshotsService, useValue: snapshots },
    ],
  }).compile();
  return module.get(PayrollInputsService);
}

async function rejectionOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => {
      throw new Error("expected a rejection, got a resolution");
    },
    (error: unknown) => error,
  );
}

describe("PayrollInputsService — locking a period is one unit or none of it", () => {
  beforeEach(() => jest.clearAllMocks());

  it("refuses the lock when the loan-installment write fails, instead of committing the period", async () => {
    const recorder = makeTx(hrLoanRepayments, [{ id: 11 }, { id: 12 }]);
    const service = await makeService(makeDb(recorder, makePeriod()));

    const rejection = await rejectionOf(service.lockPeriod("org1", "actor1", 1));

    expect(getPostgresErrorDetails(rejection)).toMatchObject({
      code: PG_CHECK_VIOLATION,
      constraint: CONSTRAINT_FAILURE,
    });
    expect(recorder.committed).toBe(false);
    expect(audit.log).not.toHaveBeenCalled();
    expect(automation.emit).not.toHaveBeenCalled();
  });

  it("refuses the lock when the leave-ledger freeze fails", async () => {
    const recorder = makeTx(hrLeaveLedger, []);
    const service = await makeService(makeDb(recorder, makePeriod()));

    const rejection = await rejectionOf(service.lockPeriod("org1", "actor1", 1));

    expect(getPostgresErrorDetails(rejection)).toMatchObject({
      code: PG_CHECK_VIOLATION,
      constraint: CONSTRAINT_FAILURE,
    });
    expect(recorder.committed).toBe(false);
    expect(audit.log).not.toHaveBeenCalled();
    expect(automation.emit).not.toHaveBeenCalled();
  });

  it("locks, freezes the ledger and stamps the installments when every write succeeds", async () => {
    const recorder = makeTx(null, [{ id: 11 }]);
    const service = await makeService(makeDb(recorder, makePeriod()));

    const locked = await service.lockPeriod("org1", "actor1", 1);

    expect(recorder.committed).toBe(true);
    expect(recorder.updatedTables).toEqual([
      getTableName(hrPayrollInputPeriods),
      getTableName(hrLeaveLedger),
      getTableName(hrLoanRepayments),
    ]);
    expect(locked.immutable).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "period.locked", orgId: "org1" }),
    );
  });

  it("refuses the unlock when the leave-ledger thaw fails, so the period cannot reopen over a frozen ledger", async () => {
    const recorder = makeTx(hrLeaveLedger, []);
    const service = await makeService(makeDb(recorder, makePeriod({ status: "locked" })));

    const rejection = await rejectionOf(service.unlockPeriod("org1", "actor1", 1));

    expect(getPostgresErrorDetails(rejection)).toMatchObject({
      code: PG_CHECK_VIOLATION,
      constraint: CONSTRAINT_FAILURE,
    });
    expect(recorder.committed).toBe(false);
    expect(audit.log).not.toHaveBeenCalled();
  });
});
