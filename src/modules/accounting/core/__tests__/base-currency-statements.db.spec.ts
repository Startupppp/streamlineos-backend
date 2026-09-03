/**
 * Real-database tests for one invariant: every base-currency figure the
 * accounting module publishes must be denominated in the ORG'S BASE CURRENCY,
 * whatever currency the underlying journal entry was written in.
 *
 * `journal_lines.debit`/`credit` hold the amount in the ENTRY's currency;
 * `base_debit`/`base_credit` hold the converted amount and are NULL whenever the
 * entry is already in base currency (finance-posting.service.ts:213-219). A
 * statement that sums the raw columns therefore adds USD 100 to INR 40 and
 * publishes 140.
 *
 * Guarded by ACCT_DB_TESTS=1 so the default hermetic `jest` run is unaffected
 * and CI without a database does not fail. Run with:
 *   ACCT_DB_TESTS=1 DATABASE_URL=... PGSSLMODE=disable \
 *     npx jest --runInBand --testPathPattern="base-currency-statements.db"
 *
 * A mocked db cannot show this defect: the assertion is about what SQL
 * `sum()` is handed, and a fake `select` returns whatever it was told to. Only a
 * real catalog, with a real mixed-currency ledger behind it, can answer.
 *
 * Every fixture lives under one throwaway org id and is removed in afterAll via
 * ON DELETE CASCADE, so the database is left exactly as it was found.
 */
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import * as schema from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import { journalEntries, ledgerAccounts } from "../../../../db/schema";
import { FinancePostingService } from "../../posting/finance-posting.service";
import { JournalPostingService } from "../../posting/journal-posting.service";
import { FinancePostingAccountsService } from "../../posting/finance-posting-accounts.service";
import { AccountingStatementsService } from "../accounting-statements.service";
import { AccountingCashFlowService } from "../accounting-cash-flow.service";
import { GeneralLedgerService } from "../../gl/general-ledger.service";
import type { AuditService } from "../../../../common/audit/audit.service";
import type { CacheService } from "../../../../common/cache/cache.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";

const ENABLED = process.env.ACCT_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

function connect() {
  if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL required for ACCT_DB_TESTS");
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  // A local Postgres has no TLS; a hosted one requires it. Derive rather than
  // hardcode so the same spec runs against either.
  const sslmode = url.searchParams.get("sslmode");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const ssl: "require" | false =
    sslmode === "disable" || process.env.PGSSLMODE === "disable" || local ? false : "require";
  return postgres(url.toString(), {
    prepare: false,
    max: 4,
    ssl,
    connect_timeout: 30,
    onnotice: () => {},
  });
}

const SUFFIX = randomUUID().slice(0, 8);
const ORG_ID = `acct-base-${SUFFIX}`;
const USER_ID = `acct-base-user-${SUFFIX}`;

/** USD -> INR. journal_lines.exchange_rate is numeric(18,8). */
const USD_INR = "83.50000000";
/** USD 100.0000 at 83.5 == INR 8350.0000. Both are major units at scale 4. */
const FOREIGN_TXN = "100.0000";
const FOREIGN_BASE = "8350.00";
/** A second entry written directly in INR, major units at scale 4. */
const DOMESTIC_BASE = "40.0000";
/** INR 8350 + INR 40. The figure every statement below must publish. */
const COMBINED_BASE = "8390.00";

describeDb("base-currency statements — real database", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let posting: FinancePostingService;
  let statements: AccountingStatementsService;
  let generalLedger: GeneralLedgerService;
  let user: CurrentUserContext;
  let entryDate: string;
  let arAccountId: number;
  let incomeAccountId: number;
  let bankAccountId: number;

  async function accountIdFor(code: string): Promise<number> {
    const [row] = await db
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.orgId, ORG_ID), eq(ledgerAccounts.code, code)));
    if (!row) throw new Error(`fixture account ${code} missing`);
    return row.id;
  }

  beforeAll(async () => {
    sql = connect();
    db = drizzle(sql, { schema });
    entryDate = new Date().toISOString().slice(0, 10);

    // organizations.owner_membership_id -> organization_members(org_id, id) is
    // DEFERRABLE INITIALLY DEFERRED, so org and membership go in one transaction.
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO users (id, name, email)
        VALUES (${USER_ID}, 'Accounting Base Fixture', ${`${USER_ID}@fixture.invalid`})
      `;
      await tx`
        INSERT INTO organizations (id, name, slug, owner_membership_id)
        VALUES (${ORG_ID}, ${`Accounting base ${SUFFIX}`}, ${`accounting-base-${SUFFIX}`}, 0)
      `;
      const [member] = await tx`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${USER_ID}, ${ORG_ID}, 'OWNER', true)
        RETURNING id
      `;
      await tx`
        UPDATE organizations SET owner_membership_id = ${member!.id} WHERE id = ${ORG_ID}
      `;
    });

    await sql`
      INSERT INTO accounting_settings (org_id, base_currency) VALUES (${ORG_ID}, 'INR')
    `;
    await sql`
      INSERT INTO accounting_periods (org_id, name, start_date, end_date, status)
      VALUES (${ORG_ID}, 'Fixture period', ${`${entryDate.slice(0, 4)}-01-01`}, ${`${entryDate.slice(0, 4)}-12-31`}, 'OPEN')
    `;
    await sql`
      INSERT INTO ledger_accounts (org_id, code, name, account_type) VALUES
        (${ORG_ID}, '1100', 'Bank', 'ASSET'),
        (${ORG_ID}, '1200', 'Accounts receivable', 'ASSET'),
        (${ORG_ID}, '4000', 'Sales revenue', 'INCOME')
    `;

    arAccountId = await accountIdFor("1200");
    incomeAccountId = await accountIdFor("4000");
    bankAccountId = await accountIdFor("1100");

    const audit = { log: jest.fn() } as unknown as AuditService;
    const dispatch = {
      emit: jest.fn().mockResolvedValue(undefined),
    } as unknown as NotificationDispatchService;
    // cachedVersioned must actually run the producer: these tests are about what
    // the producer computes, not about the cache.
    const cache = {
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
      cachedVersioned: (_ns: string, _key: string, fetcher: () => Promise<unknown>) => fetcher(),
    } as unknown as CacheService;

    posting = new FinancePostingService(db, new FinancePostingAccountsService(db), audit, dispatch, cache);
    statements = new AccountingStatementsService(db, cache, new AccountingCashFlowService(db, cache));
    generalLedger = new GeneralLedgerService(db);

    user = {
      userId: USER_ID,
      orgId: ORG_ID,
      role: "ADMIN",
      isOrgOwner: true,
      sessionId: `sess-${SUFFIX}`,
      tokenScopes: null,
      principal: humanSessionPrincipal(1, false),
    };

    // One USD entry at 83.5 and one INR entry, both POSTED, both on entryDate.
    await posting.postJournal(user, {
      entryDate,
      description: "Foreign sale",
      sourceType: "fixture_sale",
      sourceId: `usd-${SUFFIX}`,
      sourceEvent: "post",
      currency: "USD",
      exchangeRate: USD_INR,
      lines: [
        { accountId: arAccountId, debit: FOREIGN_TXN }, // USD
        { accountId: incomeAccountId, credit: FOREIGN_TXN }, // USD
      ],
    });

    await posting.postJournal(user, {
      entryDate,
      description: "Domestic sale",
      sourceType: "fixture_sale",
      sourceId: `inr-${SUFFIX}`,
      sourceEvent: "post",
      lines: [
        { accountId: arAccountId, debit: DOMESTIC_BASE }, // INR
        { accountId: incomeAccountId, credit: DOMESTIC_BASE }, // INR
      ],
    });
  }, 90_000);

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM organizations WHERE id = ${ORG_ID}`;
      await sql`DELETE FROM users WHERE id = ${USER_ID}`;
      await sql.end({ timeout: 5 });
    }
  });

  it("the trial balance values the foreign entry at the entry's rate", async () => {
    const tb = await statements.trialBalance(ORG_ID, { asOf: entryDate });
    const ar = tb.rows.find((r) => r.code === "1200");
    const income = tb.rows.find((r) => r.code === "4000");

    expect(ar?.debit).toBe(COMBINED_BASE);
    expect(income?.credit).toBe(COMBINED_BASE);
    expect(tb.totalDebit).toBe(COMBINED_BASE);
    expect(tb.totalCredit).toBe(COMBINED_BASE);
    expect(tb.balanced).toBe(true);
  }, 60_000);

  it("the balance sheet and P&L value the foreign entry at the entry's rate", async () => {
    const bs = await statements.balanceSheet(ORG_ID, { asOf: entryDate });
    expect(bs.assets.find((r) => r.code === "1200")?.balance).toBe(COMBINED_BASE);

    const from = new Date(`${entryDate}T00:00:00.000Z`);
    const to = new Date(`${entryDate}T00:00:00.000Z`);
    const pl = await statements.profitLoss(ORG_ID, { from, to });
    expect(pl.income.find((r) => r.code === "4000")?.amount).toBe(COMBINED_BASE);
    expect(pl.totalIncome).toBe(COMBINED_BASE);
  }, 60_000);

  it("the general ledger balance and running balance are base currency", async () => {
    const gl = await generalLedger.getGeneralLedger(ORG_ID, {
      accountId: arAccountId,
      from: entryDate,
      to: entryDate,
      limit: 50,
      format: "json",
    });

    expect(gl.closingBalance).toBe(Number(COMBINED_BASE));
    expect(gl.items.at(-1)?.runningBalance).toBe(Number(COMBINED_BASE));
    // The foreign line itself must be reported in the same unit as the running
    // balance beside it, or the two columns do not add up on screen.
    expect(gl.items.map((i) => i.debit)).toContain(Number(FOREIGN_BASE));
  }, 60_000);

  it("reversing a foreign entry cancels it in base currency", async () => {
    const reversed = await posting.postJournal(user, {
      entryDate,
      description: "Foreign sale to be reversed",
      sourceType: "fixture_reversible",
      sourceId: `usd-rev-${SUFFIX}`,
      sourceEvent: "post",
      currency: "USD",
      exchangeRate: USD_INR,
      lines: [
        { accountId: bankAccountId, debit: FOREIGN_TXN }, // USD
        { accountId: incomeAccountId, credit: FOREIGN_TXN }, // USD
      ],
    });

    const before = await statements.trialBalance(ORG_ID, { asOf: entryDate });
    expect(before.rows.find((r) => r.code === "1100")?.debit).toBe(FOREIGN_BASE);

    const { reversalEntryId } = await posting.reverseJournal(user, reversed.entryId, "fixture reversal");

    // Asserted over BOTH entries rather than through the trial balance, because
    // `reverseJournal` also flips the original to VOID and the statement filters
    // on POSTED — a separate, currency-independent question. What is being
    // pinned here is the ledger-level invariant: the reversal's base amounts are
    // the original's, swapped, so the two sum to zero in base currency.
    const [net] = await sql<{ base_net: string }[]>`
      SELECT coalesce(sum(coalesce(base_debit, debit) - coalesce(base_credit, credit)), 0)::text AS base_net
      FROM journal_lines
      WHERE org_id = ${ORG_ID}
        AND entry_id IN (${reversed.entryId}, ${reversalEntryId})
        AND account_id = ${bankAccountId}
    `;
    expect(Number(net!.base_net)).toBe(0);

    const [reversalLine] = await sql<{ credit: string; base_credit: string | null }[]>`
      SELECT credit::text, base_credit::text
      FROM journal_lines
      WHERE org_id = ${ORG_ID} AND entry_id = ${reversalEntryId} AND account_id = ${bankAccountId}
    `;
    // The reversal stays USD on the transaction side and INR on the base side.
    expect(reversalLine!.credit).toBe(FOREIGN_TXN);
    expect(reversalLine!.base_credit).toBe("8350.0000");
  }, 60_000);

  /**
   * The claim under audit was that `persistJournalEntry` writes POSTED entries
   * with no balance assertion at any layer. The schema half is true — the live
   * catalog carries zero CHECK constraints on `journal_entries` and
   * `journal_lines`, and the only triggers on either are the immutability
   * pair — so the code guard is the whole of the defence, and this pins that it
   * is real on both posting paths and refuses before anything is written.
   */
  it("refuses an unbalanced entry on both posting paths, writing nothing", async () => {
    const journalPosting = new JournalPostingService(db);
    const before = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.orgId, ORG_ID));

    await expect(
      journalPosting.persistJournalEntry({
        orgId: ORG_ID,
        entryDate,
        description: "Unbalanced by the GST pool",
        sourceType: "fixture_unbalanced",
        sourceId: `persist-${SUFFIX}`,
        sourceEvent: "post",
        createdBy: USER_ID,
        // INR. 1000 of debits against 1180 of credits — the exact shape a stale
        // GST split produces on an invoice whose line items were edited.
        lines: [
          { accountCode: "1200", debit: 1000, credit: 0 },
          { accountCode: "4000", debit: 0, credit: 1180 },
        ],
      }),
    ).rejects.toThrow(/Unbalanced journal entry/i);

    await expect(
      posting.postJournal(user, {
        entryDate,
        description: "Unbalanced by the GST pool",
        sourceType: "fixture_unbalanced",
        sourceId: `post-${SUFFIX}`,
        sourceEvent: "post",
        lines: [
          { accountId: arAccountId, debit: "1000.0000" }, // INR
          { accountId: incomeAccountId, credit: "1180.0000" }, // INR
        ],
      }),
    ).rejects.toThrow(/debits do not equal credits/i);

    const after = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.orgId, ORG_ID));
    expect(after.length).toBe(before.length);
  }, 60_000);

  /**
   * `assertDebitsEqualsCredits` (postJournal:125) balances the TRANSACTION
   * amounts. The base amounts are a second set of figures derived after it, and
   * a per-line conversion rounds each one half-up independently — so the sum of
   * the rounded parts is not the rounded sum, and the two sides can differ.
   * `journal_entries`/`journal_lines` carry zero CHECK constraints and no
   * balance trigger (verified in the live catalog), so nothing downstream
   * catches it.
   */
  it("a foreign entry whose conversion does not divide evenly still balances in base currency", async () => {
    // 100.0001 + 100.0001 == 200.0002 exactly, so the entry balances in USD.
    // Converted line by line at 83.5: 8350.0084 twice against 16700.0167 once.
    const posted = await posting.postJournal(user, {
      entryDate,
      description: "Foreign entry with an uneven conversion",
      sourceType: "fixture_rounding",
      sourceId: `usd-round-${SUFFIX}`,
      sourceEvent: "post",
      currency: "USD",
      exchangeRate: USD_INR,
      lines: [
        { accountId: bankAccountId, debit: "100.0001" }, // USD
        { accountId: arAccountId, debit: "100.0001" }, // USD
        { accountId: incomeAccountId, credit: "200.0002" }, // USD
      ],
    });

    const [totals] = await sql<{ base_debit: string; base_credit: string }[]>`
      SELECT
        coalesce(sum(coalesce(base_debit, debit)), 0)::text  AS base_debit,
        coalesce(sum(coalesce(base_credit, credit)), 0)::text AS base_credit
      FROM journal_lines
      WHERE org_id = ${ORG_ID} AND entry_id = ${posted.entryId}
    `;
    expect(totals!.base_debit).toBe(totals!.base_credit);

    const tb = await statements.trialBalance(ORG_ID, { asOf: entryDate });
    expect(tb.balanced).toBe(true);
  }, 60_000);

  /**
   * `fin_approval_policies.min_amount` is denominated in the org's base currency.
   * The threshold test must therefore be handed a base-currency total, or a
   * foreign journal clears a policy it is far above by being quoted in a
   * stronger unit. Runs last: it leaves an active policy on the fixture org.
   */
  describe("manual-journal approval threshold", () => {
    /** INR. USD 1,000 at 83.5 is INR 83,500 — comfortably over. */
    const MIN_AMOUNT = "50000.0000";

    beforeAll(async () => {
      await sql`
        INSERT INTO fin_approval_policies (org_id, record_type, min_amount, is_active)
        VALUES (${ORG_ID}, 'MANUAL_JOURNAL', ${MIN_AMOUNT}, true)
      `;
    });

    it("holds a foreign manual journal worth more than the base-currency minimum", async () => {
      const posted = await posting.postJournal(user, {
        entryDate,
        description: "Large foreign manual journal",
        sourceType: "manual",
        sourceId: `usd-approval-${SUFFIX}`,
        sourceEvent: "post",
        currency: "USD",
        exchangeRate: USD_INR,
        lines: [
          { accountId: bankAccountId, debit: "1000.0000" }, // USD 1,000 == INR 83,500
          { accountId: incomeAccountId, credit: "1000.0000" }, // USD
        ],
      });

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM journal_entries WHERE org_id = ${ORG_ID} AND id = ${posted.entryId}
      `;
      expect(row!.status).toBe("PENDING_APPROVAL");
    }, 60_000);

    it("still posts a base-currency manual journal below the minimum directly", async () => {
      const posted = await posting.postJournal(user, {
        entryDate,
        description: "Small domestic manual journal",
        sourceType: "manual",
        sourceId: `inr-approval-${SUFFIX}`,
        sourceEvent: "post",
        lines: [
          { accountId: bankAccountId, debit: DOMESTIC_BASE }, // INR 40
          { accountId: incomeAccountId, credit: DOMESTIC_BASE }, // INR
        ],
      });

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM journal_entries WHERE org_id = ${ORG_ID} AND id = ${posted.entryId}
      `;
      expect(row!.status).toBe("POSTED");
    }, 60_000);
  });
});
