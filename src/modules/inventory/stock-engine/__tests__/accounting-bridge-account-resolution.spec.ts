import {
  InventoryAccountingBridge,
  INVENTORY_JOURNAL_PURPOSES,
} from "../accounting-bridge";
import { PURPOSE_DEFAULT_CODE } from "../../../accounting/posting/finance-posting-accounts.service";

/**
 * INV-09 — the bridge as the one place a system-account purpose becomes an
 * account code.
 *
 * The two properties that had to hold together, and that pull in opposite
 * directions:
 *
 *   1. An organisation that has mapped INVENTORY_ASSET to its own account must
 *      have inventory post *there*. Before this, the map was write-only from
 *      inventory's side — `grep INVENTORY_ASSET src/modules/inventory` returned
 *      nothing — so the settings screen changed nothing about what a goods
 *      receipt did.
 *
 *   2. An organisation that has mapped nothing must be completely unaffected,
 *      including one whose database has no accounting module at all. A receipt
 *      is a physical fact that already happened; it may not start failing
 *      because a resolver was added underneath it.
 */
describe("InventoryAccountingBridge account resolution", () => {
  /**
   * `installed()` probes with `to_regclass` and memoises per process, so the fake
   * answers `db.execute` per table name. `presentTables` is the set that exists.
   */
  function fakeDb(options: {
    presentTables: readonly string[];
    /** Codes `ledger_accounts` holds for this org — what the missing-code check sees. */
    chartOfAccounts: readonly string[];
  }) {
    const execute = jest.fn((statement: { queryChunks?: unknown[] }) => {
      const text = JSON.stringify(statement.queryChunks ?? statement);
      const found = options.presentTables.some((table) => text.includes(table));
      return Promise.resolve([{ present: found ? `public.x` : null }]);
    });
    const where = jest
      .fn()
      .mockResolvedValue(options.chartOfAccounts.map((code) => ({ code })));
    const from = jest.fn(() => ({ where }));
    const select = jest.fn(() => ({ from }));
    return { execute, select, from, where };
  }

  function build(options: {
    presentTables?: readonly string[];
    chartOfAccounts?: readonly string[];
    mapped?: Record<string, string>;
  }) {
    const db = fakeDb({
      presentTables: options.presentTables ?? [
        "journal_entries",
        "accounting_periods",
        "acc_system_account_map",
      ],
      chartOfAccounts: options.chartOfAccounts ?? ["1300", "2000", "5000", "1200", "4000"],
    });
    const persistJournalEntry = jest.fn().mockResolvedValue({ id: 1, entryNumber: "JE1" });
    const resolveAccountCodes = jest.fn((_orgId: string, purposes: readonly string[]) =>
      Promise.resolve(
        Object.fromEntries(
          purposes.map((purpose) => [
            purpose,
            options.mapped?.[purpose] ??
              PURPOSE_DEFAULT_CODE[purpose as keyof typeof PURPOSE_DEFAULT_CODE],
          ]),
        ),
      ),
    );
    const logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const bridge = new InventoryAccountingBridge(
      db as never,
      {} as never,
      { persistJournalEntry } as never,
      { resolveAccountCodes } as never,
    );
    Object.defineProperty(bridge, "logger", { value: logger });
    return { bridge, db, persistJournalEntry, resolveAccountCodes, logger };
  }

  const receipt = {
    orgId: "org-1",
    entryDate: "2026-08-04",
    description: "Goods received: GRN-1",
    sourceType: "inv_grn",
    sourceId: "1",
    sourceEvent: "receive",
    status: "POSTED" as const,
    createdBy: "user-1",
    lines: [
      { purpose: "INVENTORY_ASSET" as const, debit: 100, credit: 0, description: "in" },
      { purpose: "INVENTORY_GRNI" as const, debit: 0, credit: 100, description: "grni" },
    ],
  };

  it("posts to the account the organisation mapped, not to the default", async () => {
    const { bridge, persistJournalEntry } = build({
      mapped: { INVENTORY_ASSET: "1355" },
      chartOfAccounts: ["1355", "2000"],
    });

    await bridge.postJournalEntry(receipt);

    const posted = persistJournalEntry.mock.calls[0]?.[0] as {
      lines: Array<{ accountCode: string }>;
    };
    expect(posted.lines.map((line) => line.accountCode)).toEqual(["1355", "2000"]);
  });

  it("posts to the default account for an organisation that mapped nothing", async () => {
    const { bridge, persistJournalEntry, logger } = build({});

    await bridge.postJournalEntry(receipt);

    const posted = persistJournalEntry.mock.calls[0]?.[0] as {
      lines: Array<{ accountCode: string }>;
    };
    // 1300 · 2000 — the literals this entry carried before INV-09 touched it.
    expect(posted.lines.map((line) => line.accountCode)).toEqual([
      PURPOSE_DEFAULT_CODE.INVENTORY_ASSET,
      PURPOSE_DEFAULT_CODE.INVENTORY_GRNI,
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("sends no purpose through to the ledger", async () => {
    // `DraftLine` has no `purpose` field and `persistJournalEntry` reads
    // `accountCode`. A line that carried both would still post; a line that
    // carried only `purpose` would post to `undefined`.
    const { bridge, persistJournalEntry } = build({});

    await bridge.postJournalEntry(receipt);

    const posted = persistJournalEntry.mock.calls[0]?.[0] as {
      lines: Array<Record<string, unknown>>;
    };
    for (const line of posted.lines) {
      expect(line.purpose).toBeUndefined();
      expect(typeof line.accountCode).toBe("string");
    }
  });

  it("still records the receipt and skips the journal when the resolved account is absent", async () => {
    // INV-07's decision, held as a test. The organisation mapped INVENTORY_ASSET
    // to an account it then deleted from its chart; the goods still arrived.
    const { bridge, persistJournalEntry, logger } = build({
      mapped: { INVENTORY_ASSET: "9999" },
      chartOfAccounts: ["2000"],
    });

    await expect(bridge.postJournalEntry(receipt)).resolves.toBeUndefined();

    expect(persistJournalEntry).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("9999"));
  });

  it("reads no mapping and posts nothing where accounting is not migrated", async () => {
    const { bridge, persistJournalEntry, resolveAccountCodes } = build({
      presentTables: [],
    });

    await bridge.postJournalEntry(receipt);

    expect(persistJournalEntry).not.toHaveBeenCalled();
    expect(resolveAccountCodes).not.toHaveBeenCalled();
  });

  it("falls back to defaults when the map table alone is missing", async () => {
    // `journal_entries` present without `acc_system_account_map` should never
    // happen — one migration creates both — but querying a table that is not
    // there raises 42P01 and Postgres then aborts every statement left in the
    // caller's transaction. The probe is what makes that unrepresentable rather
    // than unlikely.
    const { bridge, resolveAccountCodes, persistJournalEntry } = build({
      presentTables: ["journal_entries", "accounting_periods"],
    });

    await bridge.postJournalEntry(receipt);

    expect(resolveAccountCodes).not.toHaveBeenCalled();
    const posted = persistJournalEntry.mock.calls[0]?.[0] as {
      lines: Array<{ accountCode: string }>;
    };
    expect(posted.lines.map((line) => line.accountCode)).toEqual(["1300", "2000"]);
  });

  it("resolves every purpose inventory can name, in one round trip", async () => {
    const { bridge, resolveAccountCodes } = build({});

    const codes = await bridge.resolveAccountCodes("org-1");

    expect(resolveAccountCodes).toHaveBeenCalledTimes(1);
    expect(Object.keys(codes).sort()).toEqual([...INVENTORY_JOURNAL_PURPOSES].sort());
  });

  it("names no purpose it has no call site for", () => {
    // INVENTORY_WRITE_OFF and INVENTORY_ADJUSTMENT_GAIN_LOSS are mappable and
    // deliberately unused: nothing in inventory posts a journal for a write-off,
    // an adjustment or a cycle count. INVENTORY_LANDED_COST_CLEARING is likewise
    // out until INV-38 gives it an AP counterpart to be cleared by. Listing any
    // of them here would claim a posting that does not exist.
    expect(INVENTORY_JOURNAL_PURPOSES).not.toContain("INVENTORY_WRITE_OFF");
    expect(INVENTORY_JOURNAL_PURPOSES).not.toContain("INVENTORY_ADJUSTMENT_GAIN_LOSS");
    expect(INVENTORY_JOURNAL_PURPOSES).not.toContain("INVENTORY_LANDED_COST_CLEARING");
  });
});
