import { Test } from "@nestjs/testing";
import { FinancePostingService } from "./finance-posting.service";
import { AccountingStatementsService } from "../core/accounting-statements.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService, REDIS } from "../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";
import type { PostJournalInput } from "../core/finance-posting.types";
import type { AccountType } from "../core/accounting.types";

/**
 * c19-01 asks for read-after-write, not "an invalidation was called".
 *
 * So the cache here is the real `CacheService` over an in-memory Redis, and the
 * statements read runs against a ledger the posting transaction actually writes
 * to. `serves a stale statement when nothing invalidates` is the control: without
 * it a cache that never caches would pass every read-after-write below.
 */

const ORG_ID = "org-raw";
const AS_OF = "2024-01-31";

const USER: CurrentUserContext = {
  userId: "u1",
  orgId: ORG_ID,
  role: "ADMIN",
  isOrgOwner: false,
  sessionId: "sess1",
  tokenScopes: null,
};

interface LedgerAccount {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly accountType: AccountType;
}

interface LedgerLine {
  readonly accountId: number;
  readonly debit: string;
  readonly credit: string;
}

interface Ledger {
  readonly accounts: LedgerAccount[];
  readonly lines: LedgerLine[];
}

const BANK: LedgerAccount = { id: 1, code: "1100", name: "Bank", accountType: "ASSET" };
const SALES: LedgerAccount = { id: 2, code: "4000", name: "Sales", accountType: "INCOME" };

function emptyLedger(): Ledger {
  return { accounts: [BANK, SALES], lines: [] };
}

function postedInput(): PostJournalInput {
  return {
    entryDate: "2024-01-15",
    description: "Invoice posting",
    sourceType: "invoice",
    sourceId: "src1",
    sourceEvent: "create",
    lines: [
      { accountId: BANK.id, debit: "100.00", credit: "0" },
      { accountId: SALES.id, debit: "0", credit: "100.00" },
    ],
  };
}

/** What the grouped statement query would return for the ledger as it stands. */
function aggregate(ledger: Ledger): Record<string, unknown>[] {
  return ledger.accounts.map((account) => {
    const lines = ledger.lines.filter((line) => line.accountId === account.id);
    const debit = lines.reduce((total, line) => total + Number(line.debit), 0);
    const credit = lines.reduce((total, line) => total + Number(line.credit), 0);
    return {
      accountId: account.id,
      code: account.code,
      name: account.name,
      accountType: account.accountType,
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
    };
  });
}

function makeStatementsDb(ledger: Ledger): Db {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  Object.assign(builder, {
    from: chain,
    leftJoin: chain,
    innerJoin: chain,
    where: chain,
    groupBy: chain,
    orderBy: chain,
    limit: chain,
    then: (resolve: (rows: Record<string, unknown>[]) => unknown) => resolve(aggregate(ledger)),
  });
  return { select: () => builder } as unknown as Db;
}

interface PostingDbOptions {
  readonly failTransaction?: boolean;
  readonly beforeCommit?: () => Promise<void>;
}

function makePostingDb(ledger: Ledger, options: PostingDbOptions = {}): Db {
  const outerSelect = jest.fn().mockImplementation(() => {
    let call = 0;
    return {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) return Promise.resolve([{ status: "OPEN" }]);
        return Promise.resolve([{ baseCurrency: "INR" }]);
      }),
    };
  });

  const select = jest.fn().mockImplementation(() => outerSelect());

  const transaction = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    if (options.failTransaction) throw new Error("rolled back");

    const txSelect = jest.fn().mockImplementation(() => {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        from: chain,
        where: chain,
        limit: () => Promise.resolve([]),
        then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
      });
      return builder;
    });

    const txInsert = jest
      .fn()
      .mockReturnValueOnce({
        values: jest.fn().mockReturnThis(),
        onConflictDoNothing: jest.fn().mockReturnThis(),
        onConflictDoUpdate: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([{ next: 2, padding: 5 }]),
      })
      .mockReturnValueOnce({
        values: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([{ id: 42, entryNumber: "JE-202401-00001" }]),
      })
      .mockReturnValue({
        values: jest.fn().mockImplementation((rows: LedgerLine[]) => {
          ledger.lines.push(...rows.map((r) => ({ accountId: r.accountId, debit: r.debit, credit: r.credit })));
          return Promise.resolve(undefined);
        }),
      });

    const result = await fn({ select: txSelect, insert: txInsert, update: jest.fn() });
    if (options.beforeCommit) await options.beforeCommit();
    return result;
  });

  const insert = jest.fn().mockReturnValue({
    values: jest.fn().mockReturnThis(),
    onConflictDoNothing: jest.fn().mockReturnThis(),
    onConflictDoUpdate: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 42, entryNumber: "JE-202401-00001" }]),
  });

  return {
    select,
    insert,
    transaction,
    query: { finReconciliationMatches: { findFirst: jest.fn() } },
  } as unknown as Db;
}

class InMemoryRedis {
  private readonly store = new Map<string, unknown>();

  /** `deafToInvalidation` drops the generation bump, so the namespace never moves. */
  constructor(private readonly deafToInvalidation = false) {}

  get<T>(key: string): Promise<T | null> {
    const value = this.store.get(key);
    return Promise.resolve(value === undefined ? null : (value as T));
  }

  set(key: string, value: unknown, options?: { ex?: number; nx?: boolean }): Promise<string | null> {
    if (options?.nx && this.store.has(key)) return Promise.resolve(null);
    this.store.set(key, value);
    return Promise.resolve("OK");
  }

  incr(key: string): Promise<number> {
    const current = Number(this.store.get(key) ?? 0);
    if (this.deafToInvalidation) return Promise.resolve(current);
    this.store.set(key, current + 1);
    return Promise.resolve(current + 1);
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.store.delete(key) ? 1 : 0);
  }

  eval(_script: string, keys: string[]): Promise<number> {
    for (const key of keys) this.store.delete(key);
    return Promise.resolve(1);
  }
}

interface Harness {
  readonly ledger: Ledger;
  readonly posting: FinancePostingService;
  readonly statements: AccountingStatementsService;
}

async function buildHarness(
  options: PostingDbOptions = {},
  deafToInvalidation = false,
): Promise<Harness> {
  const ledger = emptyLedger();
  const cache = new CacheService(new InMemoryRedis(deafToInvalidation) as never);

  const module = await Test.createTestingModule({
    providers: [
      FinancePostingService,
      { provide: DRIZZLE, useValue: makePostingDb(ledger, options) },
      { provide: AuditService, useValue: { log: jest.fn() } },
      { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
      { provide: CacheService, useValue: cache },
      { provide: REDIS, useValue: null },
    ],
  }).compile();

  const statements = new AccountingStatementsService(makeStatementsDb(ledger), cache);

  return { ledger, posting: module.get(FinancePostingService), statements };
}

const range = { from: new Date("2024-01-01T00:00:00.000Z"), to: new Date("2024-01-31T00:00:00.000Z") };

describe("accounting statements — read after write", () => {
  it("serves a stale statement when nothing invalidates (the cache is real)", async () => {
    const { ledger, statements } = await buildHarness();

    const before = await statements.balanceSheet(ORG_ID, { asOf: AS_OF });
    ledger.lines.push({ accountId: BANK.id, debit: "500.00", credit: "0" });
    const after = await statements.balanceSheet(ORG_ID, { asOf: AS_OF });

    expect(before.totalAssets).toBe("0.00");
    expect(after).toEqual(before);
  });

  it("posting a journal entry makes the balance sheet include it", async () => {
    const { posting, statements } = await buildHarness();

    const before = await statements.balanceSheet(ORG_ID, { asOf: AS_OF });
    expect(before.totalAssets).toBe("0.00");

    await posting.postJournal(USER, postedInput());

    const after = await statements.balanceSheet(ORG_ID, { asOf: AS_OF });
    expect(after.totalAssets).toBe("100.00");
    expect(after.assets.map((row) => row.code)).toEqual([BANK.code]);
    expect(after.retainedEarnings).toBe("100.00");
    expect(after.balanced).toBe(true);
  });

  it("stays stale when the namespace bump is lost — what the invalidation buys", async () => {
    const { posting, statements } = await buildHarness({}, true);

    const before = await statements.balanceSheet(ORG_ID, { asOf: AS_OF });
    await posting.postJournal(USER, postedInput());
    const after = await statements.balanceSheet(ORG_ID, { asOf: AS_OF });

    expect(before.totalAssets).toBe("0.00");
    expect(after.totalAssets).toBe("0.00");
  });

  it("posting a journal entry makes the trial balance include it", async () => {
    const { posting, statements } = await buildHarness();

    const before = await statements.trialBalance(ORG_ID, { asOf: AS_OF });
    expect(before.totalDebit).toBe("0.00");

    await posting.postJournal(USER, postedInput());

    const after = await statements.trialBalance(ORG_ID, { asOf: AS_OF });
    expect(after.totalDebit).toBe("100.00");
    expect(after.totalCredit).toBe("100.00");
  });

  it("posting a journal entry makes profit and loss include it", async () => {
    const { posting, statements } = await buildHarness();

    const before = await statements.profitLoss(ORG_ID, range);
    expect(before.totalIncome).toBe("0.00");

    await posting.postJournal(USER, postedInput());

    const after = await statements.profitLoss(ORG_ID, range);
    expect(after.totalIncome).toBe("100.00");
    expect(after.netIncome).toBe("100.00");
  });

  it("does not invalidate before the transaction returns", async () => {
    let duringTransaction: string | undefined;
    const harness = await buildHarness({
      beforeCommit: async () => {
        const sheet = await harness.statements.balanceSheet(ORG_ID, { asOf: AS_OF });
        duringTransaction = sheet.totalAssets;
      },
    });

    await harness.statements.balanceSheet(ORG_ID, { asOf: AS_OF });
    await harness.posting.postJournal(USER, postedInput());

    expect(duringTransaction).toBe("0.00");
    const after = await harness.statements.balanceSheet(ORG_ID, { asOf: AS_OF });
    expect(after.totalAssets).toBe("100.00");
  });

  it("a rolled-back post leaves the statement showing no entry", async () => {
    const { posting, statements } = await buildHarness({ failTransaction: true });

    const before = await statements.balanceSheet(ORG_ID, { asOf: AS_OF });
    await expect(posting.postJournal(USER, postedInput())).rejects.toThrow("rolled back");

    const after = await statements.balanceSheet(ORG_ID, { asOf: AS_OF });
    expect(after.totalAssets).toBe("0.00");
    expect(after).toEqual(before);
  });
});
