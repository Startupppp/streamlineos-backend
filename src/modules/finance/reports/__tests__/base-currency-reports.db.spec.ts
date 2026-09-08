/**
 * Real-database tests for one invariant of the finance REPORTING surface: every
 * figure it publishes is denominated in the org's base currency, whatever
 * currency the underlying journal entry was written in.
 *
 * `core/journal-base-amount.ts` already covers the statements — trial balance,
 * balance sheet, P&L, cash flow, GL. The reports under `finance/reports/**` are
 * a second, larger family of aggregations over the same two columns: the finance
 * overview, project and department profitability, the insight finders and the
 * CSV export worker. They summed `journal_lines.debit`/`credit` raw, so a USD
 * entry entered the total at its face value and INR 8,350 of revenue was
 * published as INR 100.
 *
 * Run with `pnpm test:db-specs` or:
 *   DATABASE_URL=... PGSSLMODE=disable \
 *     node ./node_modules/jest/bin/jest.js --config jest-db.json --runInBand \
 *     --testPathPattern="base-currency-reports.db"
 *
 * A mocked db cannot show this: the defect is in the SQL handed to `sum()`, and
 * a fake `select` returns whatever it was told to. Only a real ledger with a
 * real mixed-currency entry in it can answer.
 *
 * Every fixture lives under one throwaway org id and is removed in afterAll via
 * ON DELETE CASCADE, so the database is left exactly as it was found.
 */
import { randomUUID } from "node:crypto";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import * as schema from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import { ledgerAccounts } from "../../../../db/schema";
import { FinancePostingService } from "../../../accounting/posting/finance-posting.service";
import { FinancePostingAccountsService } from "../../../accounting/posting/finance-posting-accounts.service";
import { OverviewService } from "../overview.service";
import { AnalyticsReportsService } from "../analytics-reports.service";
import type { AuditService } from "../../../../common/audit/audit.service";
import type { CacheService } from "../../../../common/cache/cache.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";

function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "base-currency-reports.db.spec.ts",
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
const ORG_ID = `fin-rep-${SUFFIX}`;
const USER_ID = `fin-rep-user-${SUFFIX}`;
const WORKSPACE_ID = `ws-${SUFFIX}`;

/** USD -> INR. journal_lines.exchange_rate is numeric(18,8). */
const USD_INR = "83.50000000";
/** USD 100.0000 at 83.5 == INR 8350.0000. Both are major units at scale 4. */
const FOREIGN_TXN = "100.0000";
/** A second entry written directly in INR. */
const DOMESTIC_BASE = "40.0000";
/** INR 8350 + INR 40, at the scale-2 the reports render. */
const COMBINED_BASE = "8390.00";
/** What the raw-column sum published instead: USD 100 added to INR 40. */
const RAW_TRANSACTION_SUM = "140.00";

describe("finance reports are base currency — real database", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let posting: FinancePostingService;
  let overview: OverviewService;
  let analytics: AnalyticsReportsService;
  let user: CurrentUserContext;
  let entryDate: string;
  let projectId: number;
  let arAccountId: number;
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
    // The overview's revenue figure is scoped to the CURRENT calendar month by
    // `currentMonthRange()`, so the fixture entry has to land inside it.
    entryDate = new Date().toISOString().slice(0, 10);

    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO users (id, name, email)
        VALUES (${USER_ID}, 'Finance Reports Fixture', ${`${USER_ID}@fixture.invalid`})
      `;
      await tx`
        INSERT INTO organizations (id, name, slug, owner_membership_id)
        VALUES (${ORG_ID}, ${`Finance reports ${SUFFIX}`}, ${`finance-reports-${SUFFIX}`}, 0)
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
        (${ORG_ID}, '1200', 'Accounts receivable', 'ASSET'),
        (${ORG_ID}, '4000', 'Sales revenue', 'INCOME')
    `;
    await sql`
      INSERT INTO build.pm_workspaces (pm_workspace_id, org_id, name, slug, is_default)
      VALUES (${WORKSPACE_ID}, ${ORG_ID}, 'Fixture workspace', ${`fixture-${SUFFIX}`}, true)
    `;
    const [project] = await sql<{ id: number }[]>`
      INSERT INTO build.projects (org_id, name, key, pm_workspace_id)
      VALUES (${ORG_ID}, 'Fixture project', ${`FIX${SUFFIX.slice(0, 4).toUpperCase()}`}, ${WORKSPACE_ID})
      RETURNING id
    `;
    projectId = project!.id;

    arAccountId = await accountIdFor("1200");
    incomeAccountId = await accountIdFor("4000");

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
    overview = new OverviewService(db, cache);
    analytics = new AnalyticsReportsService(db, cache);

    user = {
      userId: USER_ID,
      orgId: ORG_ID,
      role: "ADMIN",
      isOrgOwner: true,
      sessionId: `sess-${SUFFIX}`,
      tokenScopes: null,
      principal: humanSessionPrincipal(1, false),
    };

    await posting.postJournal(user, {
      entryDate,
      description: "Foreign sale",
      sourceType: "fixture_sale",
      sourceId: `usd-${SUFFIX}`,
      sourceEvent: "post",
      currency: "USD",
      exchangeRate: USD_INR,
      lines: [
        { accountId: arAccountId, debit: FOREIGN_TXN, projectId },
        { accountId: incomeAccountId, credit: FOREIGN_TXN, projectId },
      ],
    });

    await posting.postJournal(user, {
      entryDate,
      description: "Domestic sale",
      sourceType: "fixture_sale",
      sourceId: `inr-${SUFFIX}`,
      sourceEvent: "post",
      lines: [
        { accountId: arAccountId, debit: DOMESTIC_BASE, projectId },
        { accountId: incomeAccountId, credit: DOMESTIC_BASE, projectId },
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

  it("the finance overview values the foreign entry at the entry's rate", async () => {
    const result = await overview.getOverview(ORG_ID, { from: entryDate, to: entryDate });

    expect(result.revenueThisMonth).toBe(COMBINED_BASE);
    expect(result.revenueThisMonth).not.toBe(RAW_TRANSACTION_SUM);
    expect(result.netProfit).toBe(COMBINED_BASE);
  }, 60_000);

  it("the monthly revenue trend values the foreign entry at the entry's rate", async () => {
    const result = await overview.getOverview(ORG_ID, { from: entryDate, to: entryDate });
    const month = entryDate.slice(0, 7);
    const point = result.monthlyTrend.find((p) => p.month === month);

    expect(point?.revenue).toBe(COMBINED_BASE);
  }, 60_000);

  it("project profitability values the foreign entry at the entry's rate", async () => {
    const rows = await analytics.projectProfitability(ORG_ID, entryDate, entryDate);
    const row = rows.find((r) => r.projectId === projectId);

    expect(row?.revenue).toBe(COMBINED_BASE);
    expect(row?.revenue).not.toBe(RAW_TRANSACTION_SUM);
    expect(row?.margin).toBe(COMBINED_BASE);
  }, 60_000);
});
