import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { LockingService } from "./locking.service";
import type { Db } from "../../../db/drizzle.module";
import type { PayrollLockTx } from "./locking.service";

/**
 * `payroll_tds_ytd_ledger` carried one `INSERT … ON CONFLICT DO UPDATE` per run employee
 * inside the lock transaction, so a 1,000-payee run held the transaction open across 1,000
 * round trips (ticket 21 box 1 / box 3).
 *
 * The per-row shape was also wrong on its own terms. Migration 0393 made BOTH arbiters
 * PARTIAL unique indexes, and an `ON CONFLICT (cols)` with no matching `WHERE` cannot infer
 * a partial index. Measured against a scratch Postgres 2026-09-03:
 *
 *   ON CONFLICT (org_id,user_id,fiscal_year,period_key) DO UPDATE …
 *     -> ERROR: there is no unique or exclusion constraint matching the ON CONFLICT specification
 *   … WHERE user_id IS NOT NULL DO UPDATE …
 *     -> INSERT 0 1
 *
 * and a multi-row DO UPDATE carrying an intra-statement duplicate:
 *   -> ERROR: ON CONFLICT DO UPDATE command cannot affect row a second time  (21000)
 *
 * so the batch must also collapse a repeated subject before the statement is built. All
 * three properties are asserted here.
 */

const ORG_ID = "org-tds";
const RUN_ID = 900;
const MONTH = "2026-08";

interface CapturedInsert {
  table: string;
  rows: Record<string, unknown>[];
  conflict: { targetWhere?: SQL } | undefined;
}

function renderSql(fragment: SQL | undefined): string {
  if (!fragment) return "";
  return new PgDialect().sqlToQuery(fragment).sql;
}

function makeTx(employees: Record<string, unknown>[]) {
  const inserts: CapturedInsert[] = [];

  const tx = {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: RUN_ID }]),
        }),
      }),
    }),
    insert: jest.fn().mockImplementation((table: PgTable) => ({
      values: jest.fn().mockImplementation((value: unknown) => {
        const rows = Array.isArray(value) ? value : [value];
        const captured: CapturedInsert = {
          table: getTableName(table),
          rows: rows as Record<string, unknown>[],
          conflict: undefined,
        };
        inserts.push(captured);
        return Object.assign(Promise.resolve([]), {
          onConflictDoUpdate: (config: { targetWhere?: SQL }) => {
            captured.conflict = config;
            return Promise.resolve([]);
          },
        });
      }),
    })),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(employees),
        }),
      }),
    }),
  };

  return { tx: tx as unknown as PayrollLockTx, inserts };
}

function build(employees: Record<string, unknown>[]) {
  const { tx, inserts } = makeTx(employees);
  const generate = { postPayrollLock: jest.fn().mockResolvedValue(undefined) };
  const service = new LockingService(
    {} as unknown as Db,
    { log: jest.fn() } as never,
    generate as never,
  );
  return { service, tx, inserts };
}

function commit(service: LockingService, tx: PayrollLockTx) {
  return service.commitLock(tx, {
    orgId: ORG_ID,
    userId: "u-actor",
    runId: RUN_ID,
    run: {
      month: MONTH,
      status: "APPROVED",
      grossTotal: "1",
      deductionTotal: "0",
      netTotal: "1",
      employerCostTotal: "1",
    },
    membershipId: null,
    now: new Date("2026-08-31T00:00:00.000Z"),
    alsoMarkApproved: false,
  });
}

function ledgerInserts(inserts: CapturedInsert[]) {
  return inserts.filter((i) => i.table === "payroll_tds_ytd_ledger");
}

/**
 * `toCalculationSnapshot` validates the stored jsonb against the whole
 * `CalculationSnapshot` shape and returns null on any mismatch, so a partial double
 * silently made every row's TDS zero. The snapshot is built in full, with the TDS
 * amount as the MoneyString the engine writes.
 */
function snapshot(gross: string, tds: string) {
  return {
    policyVersionId: null,
    computedAt: "2026-08-31T00:00:00.000Z",
    currency: "INR",
    scheduledDays: "31",
    paidDays: "31",
    lopDays: "0",
    overtimeHours: "0",
    lines: [
      {
        code: "TDS",
        name: "Income tax",
        category: "TAX" as const,
        amount: tds,
        calcMethod: "MANUAL" as const,
        taxable: false,
        sortOrder: 1,
        explain: { method: "MANUAL" as const, inputs: {}, steps: [] },
      },
    ],
    totals: { gross, deductions: tds, employerContributions: "0.00", net: gross },
    variance: null,
  };
}

function employee(subject: { userId?: string; workerId?: string }, gross: string, tds: string) {
  return {
    userId: subject.userId ?? null,
    workerId: subject.workerId ?? null,
    gross,
    calculationSnapshot: snapshot(gross, tds),
  };
}

describe("LockingService TDS YTD ledger write", () => {
  it("writes every user subject in ONE statement, not one round trip per run employee", async () => {
    const { service, tx, inserts } = build([
      employee({ userId: "u1" }, "100", "10.00"),
      employee({ userId: "u2" }, "200", "20.00"),
      employee({ userId: "u3" }, "300", "30.00"),
    ]);

    await commit(service, tx);

    const ledger = ledgerInserts(inserts);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.rows).toHaveLength(3);
  });

  it("infers the PARTIAL user arbiter with a matching targetWhere, or Postgres raises 42P10", async () => {
    const { service, tx, inserts } = build([employee({ userId: "u1" }, "100", "10.00")]);

    await commit(service, tx);

    const rendered = renderSql(ledgerInserts(inserts)[0]!.conflict?.targetWhere);
    expect(rendered).toContain("user_id");
    expect(rendered.toLowerCase()).toContain("is not null");
  });

  it("infers the PARTIAL worker arbiter on its own separate statement", async () => {
    const { service, tx, inserts } = build([
      employee({ userId: "u1" }, "100", "10.00"),
      employee({ workerId: "w1" }, "500", "50.00"),
    ]);

    await commit(service, tx);

    const ledger = ledgerInserts(inserts);
    expect(ledger).toHaveLength(2);
    const workerStatement = ledger[1]!;
    expect(workerStatement.rows).toEqual([expect.objectContaining({ workerId: "w1", userId: null })]);
    expect(renderSql(workerStatement.conflict?.targetWhere)).toContain("worker_id");
  });

  it("collapses a repeated subject to the last row, because DO UPDATE cannot hit a row twice", async () => {
    const { service, tx, inserts } = build([
      employee({ userId: "u1" }, "100", "10.00"),
      employee({ userId: "u1" }, "999", "99.00"),
    ]);

    await commit(service, tx);

    const rows = ledgerInserts(inserts)[0]!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ userId: "u1", tdsPaise: 9900 }));
  });

  it("skips a run employee that carries neither subject", async () => {
    const { service, tx, inserts } = build([employee({}, "100", "10.00")]);

    await commit(service, tx);

    expect(ledgerInserts(inserts)).toHaveLength(0);
  });
});
