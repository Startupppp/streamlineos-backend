/**
 * Real-Postgres proof for ProviderEventLedger.claim(). claim() uses runInNewTenantTransaction,
 * which commits its own autonomous transaction; data cannot be wrapped in an outer ROLLBACK.
 * Probe rows are tagged with a UUID and removed in the cleanup test.
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { ProviderEventLedger } from "./provider-event-ledger";

const DB_URL = requireApprovedDatabaseUrl({
  spec: "provider-event-ledger.db.spec.ts",
  vars: ["LEDGER_PROBE_DATABASE_URL", "DATABASE_URL"],
});

const PROBE = `ledger-probe-${randomUUID().slice(0, 8)}`;
const EVENT = { eventType: "payment.captured", rawBody: '{"event":"payment.captured"}' };

describe("ProviderEventLedger.claim() — real Postgres conflict semantics", () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let ledger: ProviderEventLedger;
  const orgIdA = `${PROBE}-a`;
  const orgIdB = `${PROBE}-b`;
  const userId = `${PROBE}-owner`;
  let baselineTables: number;
  let baselineMigrations: number;

  beforeAll(async () => {
    client = postgres(DB_URL, { max: 4, prepare: false, onnotice: () => undefined });
    db = drizzle(client, { schema });
    ledger = new ProviderEventLedger(db);
    await client.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}@test.invalid`})`;
      for (const orgId of [orgIdA, orgIdB]) {
        await tx`
          INSERT INTO organizations (id, name, slug, owner_membership_id)
          VALUES (${orgId}, ${"Ledger probe"}, ${orgId}, 0)`;
        const [membership] = await tx<Array<{ id: number }>>`
          INSERT INTO organization_members (org_id, user_id, role, status, is_owner)
          VALUES (${orgId}, ${userId}, 'OWNER', 'ACTIVE', true) RETURNING id`;
        if (!membership) throw new Error("Ledger probe owner membership was not created");
        await tx`UPDATE organizations SET owner_membership_id = ${membership.id} WHERE id = ${orgId}`;
      }
    });
    const [tables] = await client<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`;
    const [migrations] = await client<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    baselineTables = tables?.n ?? -1;
    baselineMigrations = migrations?.n ?? -1;
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await client.begin(async (tx) => {
        await tx`SET CONSTRAINTS ALL DEFERRED`;
        await tx`DELETE FROM provider_webhook_events WHERE org_id IN (${orgIdA}, ${orgIdB})`;
        await tx`DELETE FROM organizations WHERE id IN (${orgIdA}, ${orgIdB})`;
        await tx`DELETE FROM users WHERE id = ${userId}`;
      });
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it("first claim of a fresh (org, provider, eventId) returns RECORDED", async () => {
    const result = await ledger.claim(
      { orgId: orgIdA, providerKey: "razorpay", providerEventId: `${PROBE}-t1` },
      EVENT,
    );
    expect(result).toBe("RECORDED");
  });

  it("replay before acknowledgment returns RETRY — the work must run again", async () => {
    const key = { orgId: orgIdA, providerKey: "razorpay", providerEventId: `${PROBE}-t2` };
    expect(await ledger.claim(key, EVENT)).toBe("RECORDED");
    expect(await ledger.claim(key, EVENT)).toBe("RETRY");
  });

  it("replay after processedAt is stamped returns PROCESSED — the only no-op", async () => {
    const key = { orgId: orgIdA, providerKey: "razorpay", providerEventId: `${PROBE}-t3` };
    expect(await ledger.claim(key, EVENT)).toBe("RECORDED");
    await client`
      UPDATE provider_webhook_events
         SET processed_at = NOW()
       WHERE org_id        = ${orgIdA}
         AND provider      = 'razorpay'
         AND provider_event_id = ${PROBE + "-t3"}`;
    expect(await ledger.claim(key, EVENT)).toBe("PROCESSED");
  });

  it("two different orgs claiming the same (provider, eventId) both get RECORDED — composite index does not cross-tenant block", async () => {
    const eid = `${PROBE}-t4`;
    const a = await ledger.claim({ orgId: orgIdA, providerKey: "razorpay", providerEventId: eid }, EVENT);
    const b = await ledger.claim({ orgId: orgIdB, providerKey: "razorpay", providerEventId: eid }, EVENT);
    expect(a).toBe("RECORDED");
    expect(b).toBe("RECORDED");
  });

  it("N replays leave exactly one row per (org, provider, eventId) — count it, do not infer it", async () => {
    const key = { orgId: orgIdA, providerKey: "razorpay", providerEventId: `${PROBE}-t5` };
    for (let i = 0; i < 5; i++) await ledger.claim(key, EVENT);
    const [row] = await client<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM provider_webhook_events
       WHERE org_id              = ${orgIdA}
         AND provider            = 'razorpay'
         AND provider_event_id   = ${PROBE + "-t5"}`;
    expect(row?.n).toBe(1);
  });

  // The next case is what stands in for a FOREIGN test. `claim()` returns FOREIGN only
  // when the INSERT conflicts AND the follow-up SELECT on the same
  // (orgId, provider, providerEventId) finds no row — but that SELECT queries exactly the
  // columns of the only unique index on the table, so the row that blocked the insert is
  // always the row it returns. FOREIGN is therefore unreachable unless that index changes
  // shape, which is the thing asserted below. A test that said so with expect(true) would
  // assert nothing; this one fails if the premise stops holding.
  it("live catalog confirms the unique index covers (org_id, provider, provider_event_id)", async () => {
    const [row] = await client<Array<{ def: string }>>`
      SELECT indexdef AS def
        FROM pg_indexes
       WHERE tablename  = 'provider_webhook_events'
         AND indexname  = 'uq_provider_webhook_events_provider_event'`;
    expect(row?.def).toContain("(org_id, provider, provider_event_id)");
  });

  it("cleanup: probe rows are removed and none remain", async () => {
    await client`
      DELETE FROM provider_webhook_events
       WHERE provider_event_id LIKE ${PROBE + "-%"}`;
    const [row] = await client<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM provider_webhook_events
       WHERE provider_event_id LIKE ${PROBE + "-%"}`;
    expect(row?.n).toBe(0);
  });

  // Compared against the counts taken in beforeAll, not against literals: this suite is
  // in the destructive .db.spec class and the point is that it changed no schema. Pinning
  // the numbers instead would turn the next migration into a false red here.
  it("schema guard: table and migration counts are unchanged by this suite", async () => {
    const [tables] = await client<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`;
    const [migrations] = await client<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    expect(baselineTables).toBeGreaterThan(500);
    expect(tables?.n).toBe(baselineTables);
    expect(migrations?.n).toBe(baselineMigrations);
  });
});
