/**
 * Real-database tests for one invariant of a reversal: it must cancel the entry
 * it reverses EXACTLY, at every amount `journal_lines` can hold.
 *
 * `debit`/`credit` are `numeric(18,4)`, whose range runs to
 * 99,999,999,999,999.9999 — far past 2^53/10^4 == 900,719,925,474.0992, the
 * point beyond which an IEEE-754 double stops carrying four decimal places. The
 * reversal read those columns back as text and converted them through
 * `Number(toDecimal(...))` before re-pinning, so above that threshold the
 * reconstructed line was a different amount from the one it reversed. Debits
 * then no longer equalled credits, `assertBalanced` threw, and — journal entries
 * being immutable — a posted entry became permanently uncorrectable.
 *
 * Run with:
 *   DATABASE_URL=... PGSSLMODE=disable \
 *     npx jest --config jest-db.json --runInBand --testPathPattern="journal-reversal-exactness.db"
 *
 * A mocked db cannot show this. The corruption happens between reading a real
 * `numeric(18,4)` back out of Postgres and writing it again; a fake `select`
 * hands back whatever literal the test author typed, which is by construction
 * the value that survives.
 *
 * Fixtures live under one throwaway org and are removed in afterAll via
 * ON DELETE CASCADE.
 */
import { randomUUID } from "node:crypto";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import * as schema from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import { ledgerAccounts } from "../../../../db/schema";
import { FinancePostingService } from "../../posting/finance-posting.service";
import { FinancePostingAccountsService } from "../../posting/finance-posting-accounts.service";
import { JournalPostingService } from "../../posting/journal-posting.service";
import { AccountingJournalEntryService } from "../accounting-journal-entry.service";
import { createJournalEntrySchema, JOURNAL_LINE_MAX_AMOUNT } from "../dto/accounting.schemas";
import type { AuditService } from "../../../../common/audit/audit.service";
import type { CacheService } from "../../../../common/cache/cache.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";


function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "journal-reversal-exactness.db.spec.ts",
    vars: ["DATABASE_URL"],
  });
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
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
const ORG_ID = `acct-rev-${SUFFIX}`;
const USER_ID = `acct-rev-user-${SUFFIX}`;

/**
 * Above 2^53/10^4, and not representable as a double: `Number()` rounds it to
 * ...6875. Well inside `numeric(18,4)`, so Postgres stores it as typed.
 */
const LARGE_AMOUNT = "92750470145163.6827";

describe("journal reversal is exact at ledger scale — real database", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let posting: FinancePostingService;
  let entries: AccountingJournalEntryService;
  let user: CurrentUserContext;
  let entryDate: string;
  let bankAccountId: number;
  let incomeAccountId: number;

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

    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO users (id, name, email)
        VALUES (${USER_ID}, 'Journal Reversal Fixture', ${`${USER_ID}@fixture.invalid`})
      `;
      await tx`
        INSERT INTO organizations (id, name, slug, owner_membership_id)
        VALUES (${ORG_ID}, ${`Journal reversal ${SUFFIX}`}, ${`journal-reversal-${SUFFIX}`}, 0)
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
        (${ORG_ID}, '4000', 'Sales revenue', 'INCOME')
    `;

    bankAccountId = await accountIdFor("1100");
    incomeAccountId = await accountIdFor("4000");

    const audit = { log: jest.fn() } as unknown as AuditService;
    const dispatch = {
      emit: jest.fn().mockResolvedValue(undefined),
    } as unknown as NotificationDispatchService;
    const cache = {
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
      cachedVersioned: (_ns: string, _key: string, fetcher: () => Promise<unknown>) => fetcher(),
    } as unknown as CacheService;

    posting = new FinancePostingService(db, new FinancePostingAccountsService(db), audit, dispatch, cache);
    entries = new AccountingJournalEntryService(
      db,
      new JournalPostingService(db),
      posting,
      audit,
      dispatch,
      cache,
    );

    user = {
      userId: USER_ID,
      orgId: ORG_ID,
      role: "ADMIN",
      isOrgOwner: true,
      sessionId: `sess-${SUFFIX}`,
      tokenScopes: null,
      principal: humanSessionPrincipal(1, false),
    };
  }, 90_000);

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM organizations WHERE id = ${ORG_ID}`;
      await sql`DELETE FROM users WHERE id = ${USER_ID}`;
      await sql.end({ timeout: 5 });
    }
  });

  it("reverses an entry the ledger can hold but a double cannot", async () => {
    const posted = await posting.postJournal(user, {
      entryDate,
      description: "Large domestic entry",
      sourceType: "fixture_large",
      sourceId: `large-${SUFFIX}`,
      sourceEvent: "post",
      lines: [
        { accountId: bankAccountId, debit: LARGE_AMOUNT },
        { accountId: incomeAccountId, credit: LARGE_AMOUNT },
      ],
    });

    const [original] = await sql<{ debit: string }[]>`
      SELECT debit::text FROM journal_lines
      WHERE org_id = ${ORG_ID} AND entry_id = ${posted.entryId} AND account_id = ${bankAccountId}
    `;
    expect(original!.debit).toBe(LARGE_AMOUNT);

    const { result } = await entries.reverseJournalEntry(ORG_ID, USER_ID, posted.entryId);

    const [reversal] = await sql<{ credit: string }[]>`
      SELECT credit::text FROM journal_lines
      WHERE org_id = ${ORG_ID} AND entry_id = ${result.id} AND account_id = ${bankAccountId}
    `;
    // The reversal must mirror the original to the last 0.0001. Through a double
    // this landed on ...6875 and the entry no longer balanced.
    expect(reversal!.credit).toBe(LARGE_AMOUNT);

    const [net] = await sql<{ net: string }[]>`
      SELECT coalesce(sum(debit) - sum(credit), 0)::text AS net
      FROM journal_lines
      WHERE org_id = ${ORG_ID} AND entry_id IN (${posted.entryId}, ${result.id})
    `;
    expect(Number(net!.net)).toBe(0);
  }, 60_000);

  it("refuses a manual line larger than the column can hold, instead of raising 22003", async () => {
    const line = (debit: number, credit: number) => ({ accountCode: "1100", debit, credit });
    const overflow = JOURNAL_LINE_MAX_AMOUNT * 10;

    const parsed = createJournalEntrySchema.safeParse({
      entryDate,
      description: "Beyond numeric(18,4)",
      lines: [line(overflow, 0), { accountCode: "4000", debit: 0, credit: overflow }],
    });
    expect(parsed.success).toBe(false);

    const accepted = createJournalEntrySchema.safeParse({
      entryDate,
      description: "At the column ceiling",
      lines: [
        line(JOURNAL_LINE_MAX_AMOUNT, 0),
        { accountCode: "4000", debit: 0, credit: JOURNAL_LINE_MAX_AMOUNT },
      ],
    });
    expect(accepted.success).toBe(true);
  });
});
