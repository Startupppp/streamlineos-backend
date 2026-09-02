import { AccountingStatementsService } from "./accounting-statements.service";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import type { AccountingCashFlowService } from "./accounting-cash-flow.service";

interface AggRow {
  accountId: number;
  code: string;
  name: string;
  accountType: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  debit: string | null;
  credit: string | null;
}

function buildService(rows: AggRow[]): AccountingStatementsService {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const method of ["from", "leftJoin", "innerJoin", "where"]) chain[method] = jest.fn(self);
  chain["groupBy"] = jest.fn(() => {
    const terminal = Promise.resolve(rows) as Promise<AggRow[]> & { orderBy: unknown };
    terminal.orderBy = jest.fn(() => Promise.resolve(rows));
    return terminal;
  });

  const db = { select: jest.fn(self) } as unknown as Db;
  const cache = {
    cachedVersioned: <T>(_ns: unknown, _key: string, factory: () => Promise<T>) => factory(),
  } as unknown as CacheService;
  return new AccountingStatementsService(db, cache, {} as AccountingCashFlowService);
}

/**
 * The ledger is `numeric(18,4)`. An FX-converted or tax-apportioned posting leaves a
 * third and fourth decimal behind, so a trial balance that is exact in Postgres is
 * not exact once each account's total is pushed through a JS double and printed at
 * two places — the residue is real money and it lands on one side only.
 */
function fxLedger(): AggRow[] {
  const rows: AggRow[] = [];
  let contraPaise = 0n;
  const fractions = ["0025", "0075", "0050", "0033", "0067"];
  for (let index = 0; index < 250; index += 1) {
    const rupees = 1000 + index * 37;
    const debit = `${rupees}.${fractions[index % fractions.length]}`;
    rows.push({
      accountId: index + 1,
      code: String(4000 + index),
      name: `Expense ${index}`,
      accountType: "EXPENSE",
      debit,
      credit: "0.0000",
    });
    contraPaise += BigInt(rupees) * 10000n + BigInt(fractions[index % fractions.length]);
  }
  const whole = contraPaise / 10000n;
  const frac = (contraPaise % 10000n).toString().padStart(4, "0");
  rows.push({
    accountId: 9999,
    code: "9999",
    name: "Accounts Payable",
    accountType: "LIABILITY",
    debit: "0.0000",
    credit: `${whole}.${frac}`,
  });
  return rows;
}

describe("trial balance sums money exactly", () => {
  it("balances a ledger whose exact totals agree but whose per-account doubles do not", async () => {
    const rows = fxLedger();
    const result = await buildService(rows).trialBalance("org-1", { asOf: "2026-09-02" });

    expect(result.totalDebit).toBe(result.totalCredit);
    expect(result.balanced).toBe(true);
    expect(result.totalCredit).toBe("1401626.25");
  });

  it("reproduces the imbalance the double-precision path produced on that same ledger, so the regression cannot return unnoticed", () => {
    const rows = fxLedger();
    const rounded = rows.map((row) => ({
      debit: Number(row.debit ?? 0).toFixed(2),
      credit: Number(row.credit ?? 0).toFixed(2),
    }));
    const totalDebit = rounded.reduce((acc, row) => acc + Number(row.debit), 0);
    const totalCredit = rounded.reduce((acc, row) => acc + Number(row.credit), 0);

    expect(totalDebit).not.toBe(totalCredit);
    expect((totalDebit - totalCredit).toFixed(2)).toBe("0.14");
    expect(Math.abs(totalDebit - totalCredit) < 0.01).toBe(false);
  });

  it("nets to exactly zero on the canonical binary-floating-point hazard", async () => {
    const rows: AggRow[] = [
      { accountId: 1, code: "1000", name: "Cash", accountType: "ASSET", debit: "0.1000", credit: null },
      { accountId: 2, code: "1100", name: "Bank", accountType: "ASSET", debit: "0.2000", credit: null },
      { accountId: 3, code: "4000", name: "Revenue", accountType: "INCOME", debit: null, credit: "0.3000" },
    ];
    expect(0.1 + 0.2).not.toBe(0.3);

    const result = await buildService(rows).trialBalance("org-1", { asOf: "2026-09-02" });
    expect(result.totalDebit).toBe("0.30");
    expect(result.totalCredit).toBe("0.30");
    expect(result.balanced).toBe(true);
  });

  it("keeps a fourth-decimal balance out of the totals rather than rounding it away twice", async () => {
    const rows: AggRow[] = [
      { accountId: 1, code: "1000", name: "Cash", accountType: "ASSET", debit: "100.0049", credit: null },
      { accountId: 2, code: "2000", name: "Payable", accountType: "LIABILITY", debit: null, credit: "100.0049" },
    ];
    const result = await buildService(rows).trialBalance("org-1", { asOf: "2026-09-02" });
    expect(result.rows[0].debit).toBe("100.00");
    expect(result.totalDebit).toBe("100.00");
    expect(result.balanced).toBe(true);
  });

  it("balances the balance sheet on the same exact comparison, not a one-paisa tolerance", async () => {
    const rows: AggRow[] = [
      { accountId: 1, code: "1000", name: "Cash", accountType: "ASSET", debit: "1000.0075", credit: "0.0000" },
      { accountId: 2, code: "2000", name: "Payable", accountType: "LIABILITY", debit: "0.0000", credit: "400.0025" },
      { accountId: 3, code: "3000", name: "Capital", accountType: "EQUITY", debit: "0.0000", credit: "600.0050" },
    ];
    const result = await buildService(rows).balanceSheet("org-1", { asOf: "2026-09-02" });
    expect(result.balanced).toBe(true);
    expect(result.totalAssets).toBe("1000.01");
    expect(result.totalLiabilities).toBe("400.00");
    expect(result.totalEquity).toBe("600.01");
  });
});
