import { ConflictException } from "@nestjs/common";
import { InputsService } from "../inputs.service";
import { PAYROLL_INPUT_PULL_CHUNK } from "../lib/input-puller";
import { PAYROLL_READ_CAP } from "../../lib/query-bounds";
import {
  attendance,
  leaveRequests,
  organizationMembers,
  payrollInputs,
  payrollRuns,
} from "../../../../db/schema";
import {
  hrPayrollInputPeriods,
  hrPayrollInputSnapshots,
} from "../../../../db/schema/payroll/input-capture";

const ORG = "org-1";
const RUN_ID = 7;
const MONTH = "2026-07";

type SelectCall = { table: unknown; limit: number };

function payees(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    userId: `user-${i + 1}`,
  }));
}

function snapshotRows(rows: { userId: string }[]) {
  return rows.map((row) => ({
    userId: row.userId,
    section: "attendance",
    payload: { payableDays: 30, presentDays: 30 },
  }));
}

function makeDb(options: {
  inputRows: { id: number; userId: string }[];
  lockedPeriod: boolean;
}) {
  const selectCalls: SelectCall[] = [];
  const insertedTables: unknown[] = [];
  const insertedRowCounts: number[] = [];

  const rowsFor = (table: unknown): unknown[] => {
    if (table === payrollRuns) return [{ id: RUN_ID, status: "DRAFT", month: MONTH }];
    if (table === payrollInputs) return options.inputRows;
    if (table === hrPayrollInputPeriods) return options.lockedPeriod ? [{ id: 55 }] : [];
    if (table === hrPayrollInputSnapshots) return snapshotRows(options.inputRows);
    if (table === organizationMembers)
      return options.inputRows.map((row, i) => ({ userId: row.userId, id: i + 1 }));
    if (table === attendance)
      return options.inputRows.map((row) => ({ userId: row.userId, status: "PRESENT" }));
    if (table === leaveRequests) return [];
    return [];
  };

  const select = jest.fn(() => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: (limit: number) => {
          selectCalls.push({ table, limit });
          return Promise.resolve(rowsFor(table));
        },
      }),
    }),
  }));

  const tx = {
    delete: () => ({ where: () => Promise.resolve(undefined) }),
    insert: (table: unknown) => {
      insertedTables.push(table);
      return {
        values: (rows: unknown) => {
          insertedRowCounts.push(Array.isArray(rows) ? rows.length : 1);
          return Object.assign(Promise.resolve(undefined), {
            onConflictDoUpdate: () => Promise.resolve(undefined),
          });
        },
      };
    },
  };

  const db = {
    select,
    transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  return { db, selectCalls, insertedTables, insertedRowCounts };
}

function countFor(calls: SelectCall[], table: unknown) {
  return calls.filter((call) => call.table === table).length;
}

describe("InputsService.reimportInputs — DB round-trips are bounded, not per-payee", () => {
  it("issues a call count independent of payee count (live-attendance path)", async () => {
    const small = makeDb({ inputRows: payees(50), lockedPeriod: false });
    await new InputsService(small.db as never).reimportInputs(ORG, RUN_ID, "actor-1");

    const large = makeDb({ inputRows: payees(1000), lockedPeriod: false });
    await new InputsService(large.db as never).reimportInputs(ORG, RUN_ID, "actor-1");

    // 50 payees is one chunk; 1000 payees is five. The whole growth is the four
    // extra chunks, not 950 extra round-trips.
    expect(small.selectCalls).toHaveLength(6);
    expect(large.selectCalls).toHaveLength(14);
    expect(large.selectCalls.length - small.selectCalls.length).toBe(
      (Math.ceil(1000 / PAYROLL_INPUT_PULL_CHUNK) - 1) * 2,
    );
  });

  it("never issues more calls than the documented chunk formula allows", async () => {
    const { db, selectCalls } = makeDb({ inputRows: payees(1000), lockedPeriod: true });
    await new InputsService(db as never).reimportInputs(ORG, RUN_ID, "actor-1");

    const chunks = Math.ceil(1000 / PAYROLL_INPUT_PULL_CHUNK);
    // run check + toReset + locked-period probe + memberships, plus at most
    // three statements per chunk (snapshots, attendance, leave).
    expect(selectCalls.length).toBeLessThanOrEqual(4 + chunks * 3);
    expect(selectCalls.length).toBeLessThan(1000);
  });

  it("chunks the locked-snapshot lookup so no single statement is unbounded", async () => {
    const { db, selectCalls } = makeDb({ inputRows: payees(1000), lockedPeriod: true });
    await new InputsService(db as never).reimportInputs(ORG, RUN_ID, "actor-1");

    const snapshotCalls = selectCalls.filter((c) => c.table === hrPayrollInputSnapshots);
    expect(snapshotCalls).toHaveLength(Math.ceil(1000 / PAYROLL_INPUT_PULL_CHUNK));
    for (const call of snapshotCalls)
      expect(call.limit).toBeLessThanOrEqual(PAYROLL_INPUT_PULL_CHUNK * 100);
  });

  it("writes the reimported rows in one statement instead of one per payee", async () => {
    const { db, insertedTables, insertedRowCounts } = makeDb({
      inputRows: payees(1000),
      lockedPeriod: true,
    });
    await new InputsService(db as never).reimportInputs(ORG, RUN_ID, "actor-1");

    expect(insertedTables.filter((t) => t === payrollInputs)).toHaveLength(1);
    expect(insertedRowCounts[0]).toBe(1000);
  });

  it("counts one probe row over the cap and refuses rather than truncating", async () => {
    const { db } = makeDb({
      inputRows: payees(PAYROLL_READ_CAP + 1),
      lockedPeriod: false,
    });
    await expect(
      new InputsService(db as never).reimportInputs(ORG, RUN_ID, "actor-1"),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("asks the database for the cap plus a probe row", async () => {
    const { db, selectCalls } = makeDb({ inputRows: payees(10), lockedPeriod: false });
    await new InputsService(db as never).reimportInputs(ORG, RUN_ID, "actor-1");

    const inputCall = selectCalls.find((c) => c.table === payrollInputs);
    expect(inputCall?.limit).toBe(PAYROLL_READ_CAP + 1);
    expect(countFor(selectCalls, payrollRuns)).toBe(1);
  });
});
