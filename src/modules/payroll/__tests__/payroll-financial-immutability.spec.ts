import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { PAYROLL_RUN_TRANSITIONS } from "../payroll.types";
import type { PayrollRunStatus } from "../payroll.types";

/**
 * PRD 10.7: payroll financial records are immutable where financial, at the data
 * layer and not only in a service. Eight tables carry money; 0445 guarded two,
 * 1001 guarded five and 1030 the last one. This spec is the static half of that
 * proof — the behavioural half runs against a scratch database.
 *
 * The second group is the load-bearing one. 1030 freezes a TDS ledger row on
 * PAID / PAYSLIPS_PUBLISHED / CLOSED, and that predicate is only safe because the
 * run state machine cannot walk back from any of those into a lockable state:
 * locking.service.ts re-enters writeTdsYtdLedger on every lock, so a frozen
 * status that could re-lock would block the legitimate reopen → re-lock cycle.
 * Adding PAID → REOPENED to PAYROLL_RUN_TRANSITIONS would do exactly that, and
 * would break run locking with a 23514 rather than failing here.
 */

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "..", "migrations");

const GUARDED: ReadonlyArray<{ table: string; trigger: string; migration: string }> = [
  {
    table: "payroll_run_employees",
    trigger: "trg_guard_locked_payroll_run_employee",
    migration: "0445_payroll_locked_run_immutability.sql",
  },
  {
    table: "payroll_line_items",
    trigger: "trg_guard_locked_payroll_line_item",
    migration: "0445_payroll_locked_run_immutability.sql",
  },
  {
    table: "payroll_journal_batches",
    trigger: "trg_guard_posted_payroll_journal_batch",
    migration: "1001_s08_payroll_financial_immutability.sql",
  },
  {
    table: "payroll_journal_batch_lines",
    trigger: "trg_guard_posted_payroll_journal_batch_line",
    migration: "1001_s08_payroll_financial_immutability.sql",
  },
  {
    table: "payroll_bank_batches",
    trigger: "trg_guard_released_payroll_bank_batch",
    migration: "1001_s08_payroll_financial_immutability.sql",
  },
  {
    table: "payroll_bank_batch_items",
    trigger: "trg_guard_released_payroll_bank_batch_item",
    migration: "1001_s08_payroll_financial_immutability.sql",
  },
  {
    table: "payroll_filings",
    trigger: "trg_guard_submitted_payroll_filing",
    migration: "1001_s08_payroll_financial_immutability.sql",
  },
  {
    table: "payroll_tds_ytd_ledger",
    trigger: "trg_guard_paid_payroll_tds_ytd_row",
    migration: "1030_t24_payroll_tds_ytd_immutability.sql",
  },
];

/** Statuses 1030 treats as frozen for payroll_tds_ytd_ledger. */
const PAID_OUT: ReadonlyArray<PayrollRunStatus> = ["PAID", "PAYSLIPS_PUBLISHED", "CLOSED"];

/** Statuses from which locking.service.commitLock can run and re-enter the ledger upsert. */
const LOCKABLE: ReadonlyArray<PayrollRunStatus> = ["APPROVED"];

function reachable(from: PayrollRunStatus): Set<PayrollRunStatus> {
  const seen = new Set<PayrollRunStatus>();
  const queue: PayrollRunStatus[] = [from];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    for (const to of PAYROLL_RUN_TRANSITIONS[next]) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return seen;
}

describe("payroll financial immutability — data layer", () => {
  it("finds the migrations directory it is meant to police", () => {
    expect(existsSync(MIGRATIONS_DIR)).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).length).toBeGreaterThan(600);
  });

  it.each(GUARDED)(
    "$table carries a BEFORE UPDATE OR DELETE guard created by $migration",
    ({ table, trigger, migration }) => {
      const file = join(MIGRATIONS_DIR, migration);
      expect(existsSync(file)).toBe(true);
      const sql = readFileSync(file, "utf8");
      expect(sql).toContain(`CREATE TRIGGER ${trigger}`);
      expect(sql).toMatch(
        new RegExp(`CREATE TRIGGER ${trigger}\\s+BEFORE[^;]*?\\bUPDATE\\b[^;]*?\\bON ${table}\\b`),
      );
      expect(sql).toMatch(
        new RegExp(`CREATE TRIGGER ${trigger}\\s+BEFORE[^;]*?\\bDELETE\\b[^;]*?\\bON ${table}\\b`),
      );
    },
  );

  it("every guard is journalled, so db:migrate cannot skip it while printing success", () => {
    const journal = readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8");
    for (const { migration } of GUARDED)
      expect(journal).toContain(`"tag": "${migration.replace(/\.sql$/, "")}"`);
  });

  it("1030 has a rollback, so the guard is reversible", () => {
    expect(
      existsSync(join(MIGRATIONS_DIR, "rollback", "1030_t24_payroll_tds_ytd_immutability.down.sql")),
    ).toBe(true);
  });
});

describe("1030's frozen predicate is safe against the run state machine", () => {
  it("no paid-out status can reach a lockable status, so a re-lock never sees a frozen ledger row", () => {
    for (const status of PAID_OUT) {
      const onward = reachable(status);
      for (const lockable of LOCKABLE) expect(onward.has(lockable)).toBe(false);
      expect(onward.has("REOPENED")).toBe(false);
      expect(onward.has("DRAFT")).toBe(false);
    }
  });

  it("the reopen cycle a lock legitimately repeats stays outside the frozen set", () => {
    expect(PAYROLL_RUN_TRANSITIONS.LOCKED).toContain("REOPENED");
    expect(PAID_OUT).not.toContain("LOCKED");
    for (const [status, targets] of Object.entries(PAYROLL_RUN_TRANSITIONS)) {
      if (targets.includes("REOPENED")) expect(status).toBe("LOCKED");
    }
  });

  it("control: a status the guard does not freeze can still reach a lock", () => {
    expect(reachable("PREPARING").has("LOCKED")).toBe(true);
    expect(reachable("LOCKED").has("PAID")).toBe(true);
  });
});
