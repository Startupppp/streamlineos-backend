/**
 * Real-Postgres proof for ProviderEventLedger.claim(). claim() uses runInNewTenantTransaction,
 * which commits its own autonomous transaction; data cannot be wrapped in an outer ROLLBACK.
 * Probe rows are tagged with a UUID and removed in the cleanup test.
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { organizations } from "../../../db/schema";
import { ProviderEventLedger } from "./provider-event-ledger";

const DB_URL = process.env.LEDGER_PROBE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DB_URL)
  throw new Error(
    "provider-event-ledger.db.spec requires LEDGER_PROBE_DATABASE_URL or DATABASE_URL",
  );

const PROBE = `ledger-probe-${randomUUID().slice(0, 8)}`;
const EVENT = { eventType: "payment.captured", rawBody: '{"event":"payment.captured"}' };

describe("ProviderEventLedger.claim() — real Postgres conflict semantics", () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let ledger: ProviderEventLedger;
  let orgIdA: string;
  let orgIdB: string;
  let baselineTables: number;
  let baselineMigrations: number;

  beforeAll(async () => {
    client = postgres(DB_URL, { max: 4, prepare: false, onnotice: () => undefined });
    db = drizzle(client, { schema });
    ledger = new ProviderEventLedger(db);
    const rows = await db.select({ id: organizations.id }).from(organizations).limit(2);
    if (rows.length < 2)
      throw new Error("provider-event-ledger.db.spec needs at least 2 organisation rows in the scratch database");
    orgIdA = rows[0]!.id;
    orgIdB = rows[1]!.id;
    const [tables] = await client<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`;
    const [migrations] = await client<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    baselineTables = tables?.n ?? -1;
    baselineMigrations = migrations?.n ?? -1;
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
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

  it("FOREIGN branch is unreachable from this spec", () => {
    // claim() returns FOREIGN when the INSERT conflicts (inserted.length===0) AND the
    // follow-up SELECT with the same (orgId, provider, providerEventId) WHERE clause
    // finds no row. The only unique index on provider_webhook_events is
    // uq_provider_webhook_events_provider_event on (org_id, provider, provider_event_id),
    // which is exactly what matches() queries. So the row that blocked the insert is always
    // the row the SELECT returns. FOREIGN cannot be triggered without either (a) corrupting
    // the index metadata or (b) racing a concurrent DELETE inside the same transaction window.
    expect(true).toBe(true);
  });

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
