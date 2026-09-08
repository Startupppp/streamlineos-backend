/**
 * Real-database tests for the provider-payment finance bridge.
 *
 * Run with `pnpm test:db-specs` or:
 *   DATABASE_URL=... PGSSLMODE=disable \
 *     node ./node_modules/jest/bin/jest.js --config jest-db.json --runInBand \
 *     --testPathPattern="provider-bridge-posting.db"
 *
 * A mocked db cannot show either defect these pin. The first is a foreign-key
 * violation raised by Postgres (`journal_entries.posted_by` REFERENCES
 * `users(id)`, validated and not deferrable) — a fake `insert` accepts any actor
 * id. The second is the base-currency guard in FinancePostingService, which only
 * has an answer once a real `accounting_settings` row and a real
 * `fin_exchange_rates` row exist. Both are reached only by running the real
 * FinancePostingService against a real catalog.
 *
 * Every fixture lives under one throwaway org id and is removed in afterAll via
 * ON DELETE CASCADE, so the database is left exactly as it was found.
 */
import { randomUUID } from "node:crypto";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.types";
import { journalEntries, journalLines } from "../../../../db/schema";
import { FinancePostingService } from "../../../accounting/posting/finance-posting.service";
import { FinancePostingAccountsService } from "../../../accounting/posting/finance-posting-accounts.service";
import { RateResolverService } from "../rate-resolver.service";
import { ProviderBridgeService } from "../provider-bridge.service";
import type { AuditService } from "../../../../common/audit/audit.service";
import type { CacheService } from "../../../../common/cache/cache.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";

function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "provider-bridge-posting.db.spec.ts",
    vars: ["DATABASE_URL"],
  });
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
const ORG_ID = `fin-bridge-${SUFFIX}`;
const USER_ID = `fin-bridge-user-${SUFFIX}`;
/** USD -> INR on the payment date. Rate is a scale-8 numeric in fin_exchange_rates. */
const USD_INR = "83.5000000";

describe("provider payment bridge — real database", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let bridge: ProviderBridgeService;
  /** Payment date used by every case; must fall inside the OPEN period below. */
  let occurredAt: Date;
  let entryDate: string;

  beforeAll(async () => {
    sql = connect();
    // Only the tables this spec reads; the barrel's namespace import is banned by
    // no-restricted-imports and nothing here uses the relational query API.
    db = drizzle(sql, { schema: { journalEntries, journalLines } }) as unknown as Db;

    occurredAt = new Date();
    entryDate = occurredAt.toISOString().slice(0, 10);

    // organizations.owner_membership_id -> organization_members(org_id, id) is
    // DEFERRABLE INITIALLY DEFERRED, so org and membership go in one transaction.
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO users (id, name, email)
        VALUES (${USER_ID}, 'Finance Bridge Fixture', ${`${USER_ID}@fixture.invalid`})
      `;
      await tx`
        INSERT INTO organizations (id, name, slug, owner_membership_id)
        VALUES (${ORG_ID}, ${`Finance bridge ${SUFFIX}`}, ${`finance-bridge-${SUFFIX}`}, 0)
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
    // Only the codes the bridge's three line purposes resolve to:
    // 1100 BANK_CLEARING, 1200 AR, 5910 PAYMENT_FEES.
    await sql`
      INSERT INTO ledger_accounts (org_id, code, name, account_type) VALUES
        (${ORG_ID}, '1100', 'Bank clearing', 'ASSET'),
        (${ORG_ID}, '1200', 'Accounts receivable', 'ASSET'),
        (${ORG_ID}, '5910', 'Payment processing fees', 'EXPENSE')
    `;
    await sql`
      INSERT INTO fin_exchange_rates (org_id, from_currency, to_currency, rate, as_of_date)
      VALUES (${ORG_ID}, 'USD', 'INR', ${USD_INR}, ${entryDate})
    `;

    const accounts = new FinancePostingAccountsService(db);
    const audit = { log: jest.fn() } as unknown as AuditService;
    const dispatch = {
      emit: jest.fn().mockResolvedValue(undefined),
    } as unknown as NotificationDispatchService;
    const cache = {
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    const posting = new FinancePostingService(db, accounts, audit, dispatch, cache);
    bridge = new ProviderBridgeService(posting, new RateResolverService(db), db);
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM organizations WHERE id = ${ORG_ID}`;
      await sql`DELETE FROM users WHERE id = ${USER_ID}`;
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  async function entryFor(providerEventId: string) {
    const rows = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.orgId, ORG_ID),
          eq(journalEntries.sourceType, "PROVIDER_PAYMENT"),
          eq(journalEntries.sourceId, providerEventId),
        ),
      );
    return rows[0] ?? null;
  }

  async function linesFor(entryId: number) {
    return db
      .select()
      .from(journalLines)
      .where(and(eq(journalLines.orgId, ORG_ID), eq(journalLines.entryId, entryId)))
      .orderBy(journalLines.lineOrder);
  }

  it("a base-currency provider payment reaches the ledger", async () => {
    const eventId = `evt_inr_${SUFFIX}`;

    // The webhook receiver passes the literal actor id "system"
    // (payment-webhook-receiver.service.ts:292); journal_entries.posted_by is a
    // validated FK to users(id) and no "system" row exists.
    await bridge.recordProviderPayment(ORG_ID, "system", {
      provider: "razorpay",
      providerEventId: eventId,
      grossAmount: "100.0000", // INR, major units as a decimal string
      feeAmount: "2.0000", // INR
      currency: "INR",
      occurredAt,
    });

    const entry = await entryFor(eventId);
    expect(entry).not.toBeNull();
    expect(entry!.currency).toBe("INR");
    expect(entry!.status).toBe("POSTED");

    const lines = await linesFor(entry!.id);
    // net 98 debit to bank clearing, 2 debit to fees, 100 credit to AR
    expect(lines.map((l) => [l.debit, l.credit])).toEqual([
      ["98.0000", "0.0000"],
      ["2.0000", "0.0000"],
      ["0.0000", "100.0000"],
    ]);
  }, 60_000);

  it("a foreign-currency provider payment reaches the ledger valued at the org's rate", async () => {
    const eventId = `evt_usd_${SUFFIX}`;

    await bridge.recordProviderPayment(ORG_ID, "system", {
      provider: "stripe",
      providerEventId: eventId,
      grossAmount: "100.0000", // USD, major units as a decimal string
      feeAmount: "3.0000", // USD
      currency: "USD",
      occurredAt,
    });

    const entry = await entryFor(eventId);
    expect(entry).not.toBeNull();
    expect(entry!.currency).toBe("USD");
    expect(entry!.status).toBe("POSTED");

    const lines = await linesFor(entry!.id);
    // Transaction currency stays USD; base_debit/base_credit carry INR at 83.50.
    expect(lines.map((l) => [l.debit, l.credit])).toEqual([
      ["97.0000", "0.0000"],
      ["3.0000", "0.0000"],
      ["0.0000", "100.0000"],
    ]);
    expect(lines.map((l) => [l.baseDebit, l.baseCredit])).toEqual([
      ["8099.5000", "0.0000"],
      ["250.5000", "0.0000"],
      ["0.0000", "8350.0000"],
    ]);
    expect(lines.every((l) => l.currency === "USD")).toBe(true);
    expect(lines.every((l) => l.exchangeRate === "83.50000000")).toBe(true);
  }, 60_000);

  it("re-delivering the same provider event does not double-post", async () => {
    const eventId = `evt_replay_${SUFFIX}`;
    const input = {
      provider: "stripe",
      providerEventId: eventId,
      grossAmount: "40.0000", // USD
      feeAmount: "1.0000", // USD
      currency: "USD",
      occurredAt,
    };

    await bridge.recordProviderPayment(ORG_ID, "system", input);
    await bridge.recordProviderPayment(ORG_ID, "system", input);

    const rows = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.orgId, ORG_ID),
          eq(journalEntries.sourceType, "PROVIDER_PAYMENT"),
          eq(journalEntries.sourceId, eventId),
        ),
      );
    expect(rows).toHaveLength(1);
  }, 60_000);

  it("a currency the org has no rate for is refused, not silently mis-valued", async () => {
    const eventId = `evt_norate_${SUFFIX}`;

    await expect(
      bridge.recordProviderPayment(ORG_ID, "system", {
        provider: "stripe",
        providerEventId: eventId,
        grossAmount: "10.0000", // EUR
        feeAmount: "0.0000", // EUR
        currency: "EUR",
        occurredAt,
      }),
    ).rejects.toThrow(/No exchange rate/i);

    expect(await entryFor(eventId)).toBeNull();
  }, 60_000);
});
