import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConflictException } from "@nestjs/common";
import { AdapterRejection } from "../../../accounting/adapters/posting-command.types";
import { sqlValues } from "../../__tests__/isolation-harness";
import {
  InventoryAccountingBridge,
  INVENTORY_JOURNAL_PURPOSES,
  INVENTORY_PURPOSE_TAG,
  minorUnitsToDecimal,
  toMinorUnits,
  type InventoryJournalDraft,
} from "../accounting-bridge";

/**
 * INV-09 on the accounting kernel — the bridge as the one place an inventory
 * purpose becomes an account role, and a decimal becomes minor units.
 *
 * The properties that have to hold together:
 *
 *   1. A journal names roles (`gl_system_tag`), never an account id or code,
 *      so a tenant that renumbers or re-tags its chart keeps posting correctly.
 *   2. Amounts reach the ledger as exact whole minor units, on the caller's own
 *      transaction.
 *   3. An organisation that never enabled accounting is unaffected, and one
 *      that did has a post it cannot honour REFUSED, not skipped. That is the
 *      kernel's fail-closed contract, which replaced the legacy warn-and-skip.
 */
describe("InventoryAccountingBridge on the accounting kernel", () => {
  function build(
    options: {
      book?: { id: string } | null;
      accounts?: Array<{ code: string; systemTag: string }>;
      submit?: jest.Mock;
      period?: { id: string; name: string; status: "OPEN" | "LOCKED" } | null;
    } = {},
  ) {
    const limit = jest.fn().mockResolvedValue(options.accounts ?? []);
    const where = jest.fn((_clause?: unknown) => ({ limit }));
    const from = jest.fn(() => ({ where }));
    const select = jest.fn(() => ({ from }));
    const books = {
      findDefault: jest
        .fn()
        .mockResolvedValue(options.book === undefined ? { id: "book-1" } : options.book),
    };
    const periods = { periodForDate: jest.fn().mockResolvedValue(options.period ?? null) };
    const submit =
      options.submit ??
      jest.fn().mockResolvedValue({ journalId: "j-1", journalNumber: "JV-1", replayed: false });
    const bridge = new InventoryAccountingBridge(
      { select } as never,
      books as never,
      periods as never,
      { submit } as never,
    );
    Object.defineProperty(bridge, "logger", {
      value: { debug: jest.fn(), warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    });
    return { bridge, select, where, limit, books, periods, submit };
  }

  const receipt: InventoryJournalDraft = {
    orgId: "org-1",
    createdBy: "user-1",
    entryDate: "2026-08-04",
    description: "Goods received: GRN-1",
    sourceType: "inv_grn",
    sourceId: "7",
    sourceEvent: "receive",
    lines: [
      { purpose: "INVENTORY_ASSET", debit: "1234.5650", description: "in" },
      { purpose: "INVENTORY_GRNI", credit: "1234.5650", description: "grni" },
    ],
  };
  const tx = { marker: "the receipt's own transaction" };

  describe("posting", () => {
    it("submits under the receipt's key, on the caller's transaction", async () => {
      const { bridge, submit } = build();

      await bridge.postJournalEntry(receipt, tx as never);

      expect(submit).toHaveBeenCalledTimes(1);
      const [orgId, userId, command, passedTx] = submit.mock.calls[0]!;
      expect(orgId).toBe("org-1");
      expect(userId).toBe("user-1");
      // Identity, not equality: a copy would be a different connection.
      expect(passedTx).toBe(tx);
      expect(command).toMatchObject({
        sourceType: "stock_move",
        sourceId: "7",
        purpose: "receive",
        journalDate: "2026-08-04",
        memo: "Goods received: GRN-1",
      });
    });

    it("resolves each purpose to its role and each amount to exact minor units", async () => {
      const { bridge, submit } = build();

      await bridge.postJournalEntry(receipt, tx as never);

      // 1234.5650 rounds half-up to 123457 hundredths on both sides, so the
      // journal balances by construction.
      expect(submit.mock.calls[0]![2].lines).toEqual([
        { accountTag: "inventory", debitMinor: 123457, description: "in" },
        { accountTag: "ap_control", creditMinor: 123457, description: "grni" },
      ]);
    });

    it("sends no purpose, account code or account id through to the ledger", async () => {
      const { bridge, submit } = build();

      await bridge.postJournalEntry(receipt, tx as never);

      for (const line of submit.mock.calls[0]![2].lines as Array<Record<string, unknown>>) {
        expect(line.purpose).toBeUndefined();
        expect(line.accountCode).toBeUndefined();
        expect(line.accountId).toBeUndefined();
        expect(typeof line.accountTag).toBe("string");
      }
    });

    it("skips where the organisation never enabled accounting", async () => {
      const submit = jest
        .fn()
        .mockRejectedValue(new AdapterRejection("BOOK_NOT_ENABLED", "no book"));
      const { bridge } = build({ submit });

      await expect(bridge.postJournalEntry(receipt, tx as never)).resolves.toBeUndefined();
    });

    it("refuses, rather than warning and skipping, when a role has no account", async () => {
      // INV-07's legacy decision was to skip here. On the kernel a missing role
      // on an enabled tenant refuses the post, and the caller's stock change
      // rolls back with it.
      const refusal = new AdapterRejection("UNKNOWN_ACCOUNT_TAG", 'No account is tagged "inventory"');
      const { bridge } = build({ submit: jest.fn().mockRejectedValue(refusal) });

      await expect(bridge.postJournalEntry(receipt, tx as never)).rejects.toBe(refusal);
    });

    it("rethrows anything else the ledger refuses, such as a locked period", async () => {
      const locked = new Error("Period Aug 2026 is locked");
      const { bridge } = build({ submit: jest.fn().mockRejectedValue(locked) });

      await expect(bridge.postJournalEntry(receipt, tx as never)).rejects.toBe(locked);
    });

    it("posts nothing for a draft whose lines round to zero", async () => {
      const { bridge, submit } = build();

      await bridge.postJournalEntry(
        {
          ...receipt,
          lines: [
            { purpose: "INVENTORY_ASSET", debit: "0.0040" },
            { purpose: "INVENTORY_GRNI", credit: "0.0040" },
          ],
        },
        tx as never,
      );

      expect(submit).not.toHaveBeenCalled();
    });

    it("refuses a line that is both a debit and a credit", async () => {
      const { bridge } = build();

      await expect(
        bridge.postJournalEntry(
          { ...receipt, lines: [{ purpose: "INVENTORY_ASSET", debit: "1.00", credit: "1.00" }] },
          tx as never,
        ),
      ).rejects.toThrow(/debit or a credit/);
    });
  });

  describe("minor units", () => {
    it.each<[string, number]>([
      ["12", 1200],
      ["1.10", 110],
      ["0.005", 1],
      ["0.0049", 0],
      ["1234.5650", 123457],
      // A float would say 100: 1.005 * 100 is 100.49999…
      ["1.005", 101],
    ])("takes %s to %d hundredths, exactly", (amount, minor) => {
      expect(toMinorUnits(amount)).toBe(minor);
    });

    it.each(["-1", "1e3", "abc", ""])("refuses %j", (amount) => {
      expect(() => toMinorUnits(amount)).toThrow();
    });

    it("round-trips through the decimal form", () => {
      for (const minor of [0, 5, 99, 100, 1234, 123457]) {
        expect(toMinorUnits(minorUnitsToDecimal(minor))).toBe(minor);
      }
      expect(minorUnitsToDecimal(1234)).toBe("12.34");
      expect(minorUnitsToDecimal(5)).toBe("0.05");
    });
  });

  describe("account codes", () => {
    it("answers null for every purpose, and reads no chart, where there is no book", async () => {
      const { bridge, select } = build({ book: null });

      const codes = await bridge.resolveAccountCodes("org-1");

      expect(Object.values(codes).every((code) => code === null)).toBe(true);
      expect(select).not.toHaveBeenCalled();
    });

    it("reads each purpose's code off the account tagged with its role", async () => {
      const { bridge } = build({
        accounts: [
          { code: "1355", systemTag: "inventory" },
          { code: "2000", systemTag: "ap_control" },
          { code: "5000", systemTag: "cogs" },
        ],
      });

      const codes = await bridge.resolveAccountCodes("org-1");

      expect(codes).toEqual({
        INVENTORY_ASSET: "1355",
        INVENTORY_COGS: "5000",
        INVENTORY_GRNI: "2000",
        AP: "2000",
        AR: null,
        SALES_INCOME: null,
      });
    });

    it("reads the chart of this organisation's own book, in one bounded round trip", async () => {
      const { bridge, select, where, limit } = build();

      await bridge.resolveAccountCodes("org-1");

      expect(select).toHaveBeenCalledTimes(1);
      const bound = sqlValues(where.mock.calls[0]![0]);
      expect(bound).toContain("org-1");
      expect(bound).toContain("book-1");
      // One account per role per book (uniq_gl_accounts_book_system_tag).
      expect(limit).toHaveBeenCalledWith(new Set(Object.values(INVENTORY_PURPOSE_TAG)).size);
    });

    it("names no purpose it has no call site for", () => {
      expect(INVENTORY_JOURNAL_PURPOSES).not.toContain("INVENTORY_WRITE_OFF");
      expect(INVENTORY_JOURNAL_PURPOSES).not.toContain("INVENTORY_ADJUSTMENT_GAIN_LOSS");
      expect(INVENTORY_JOURNAL_PURPOSES).not.toContain("INVENTORY_LANDED_COST_CLEARING");
      expect(Object.keys(INVENTORY_PURPOSE_TAG).sort()).toEqual([...INVENTORY_JOURNAL_PURPOSES].sort());
    });

    it("credits the receipt to the same role on both receipt paths", () => {
      // TODO(ACC-03) is to move both to `grni` together. One path moving alone
      // would book one event to two different accounts.
      const oneShot = readFileSync(
        join(__dirname, "..", "..", "purchase-orders", "grn-receive.service.ts"),
        "utf8",
      );
      expect(oneShot).toContain(`accountTag: "${INVENTORY_PURPOSE_TAG.INVENTORY_GRNI}"`);
    });
  });

  describe("periods", () => {
    it("refuses a movement into a locked period", async () => {
      const { bridge } = build({ period: { id: "p-8", name: "Aug 2026", status: "LOCKED" } });

      await expect(bridge.assertOpen("org-1", "2026-08-04")).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it("lets an open period through, asking the organisation's own book", async () => {
      const { bridge, periods } = build({ period: { id: "p-8", name: "Aug 2026", status: "OPEN" } });

      await expect(bridge.assertOpen("org-1", "2026-08-04")).resolves.toBeUndefined();
      expect(periods.periodForDate).toHaveBeenCalledWith("book-1", "2026-08-04");
    });

    it("leaves an organisation without accounting unguarded", async () => {
      const { bridge, periods } = build({ book: null });

      await expect(bridge.assertOpen("org-1", "2026-08-04")).resolves.toBeUndefined();
      expect(periods.periodForDate).not.toHaveBeenCalled();
    });

    it("answers hasJournals and hasPeriods from the book", async () => {
      await expect(build().bridge.hasJournals("org-1")).resolves.toBe(true);
      await expect(build().bridge.hasPeriods("org-1")).resolves.toBe(true);
      await expect(build({ book: null }).bridge.hasJournals("org-1")).resolves.toBe(false);
      await expect(build({ book: null }).bridge.hasPeriods("org-1")).resolves.toBe(false);
    });
  });
});
