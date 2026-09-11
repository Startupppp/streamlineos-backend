/**
 * Focused performance regression guard for GET /calendar/events.
 *
 * Root cause fixed 2026-09-06: candidatePage() used CALENDAR_EVENTS_CAP (2000) as the
 * SQL LIMIT, causing fetchEvents() to transfer up to 2000 full event rows (including the
 * description column) even though CalendarSourceRegistry truncates each source to
 * CALENDAR_PER_SOURCE_CAP (400) projections. The fix reduces both LIMIT and .slice() to
 * CALENDAR_PER_SOURCE_CAP, cutting the DB data-transfer for the large tenant 5×.
 *
 * What this spec asserts:
 *   p95 latency  ≤ 800 ms  (the prdCeilingMs in contracts/route-budgets.json)
 *   DB statements ≤ POST-FIX count recorded per tenant
 *
 * It runs 20 samples per tenant. It does NOT gate on response bytes (that is a wire
 * concern covered by the full HTTP budget suite), nor on heap (requires --expose-gc).
 *
 * Prerequisites (same as route-budget-http.seeded-e2e-spec.ts):
 *   DATABASE_URL           owner role on a scratch database
 *   APP_DATABASE_URL       non-owner app role on the SAME scratch database
 *   SEED_ORG_ID            the large-tenant UUID
 *   SEED_MINORITY_ORG_ID   the small-tenant UUID
 *   AUTH_SIGNING_KEYS      local Ed25519 keyring placeholder
 */

import request from "supertest";
import { createSeededE2eApp, signSeededToken, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { eq } from "drizzle-orm";
import { organizationMembers } from "src/db/schema";
import { queryTelemetry } from "src/db/query-telemetry";
import { DownstreamCounter } from "test/perf/route-budget-http-harness";

jest.setTimeout(600_000);

const LARGE_ORG = process.env.SEED_ORG_ID ?? "";
const SMALL_ORG = process.env.SEED_MINORITY_ORG_ID ?? "";
const USABLE =
  (process.env.DATABASE_URL ?? "").length > 0 &&
  (process.env.APP_DATABASE_URL ?? "").length > 0 &&
  /scratch/i.test(process.env.APP_DATABASE_URL ?? "") &&
  LARGE_ORG.length > 0 &&
  (process.env.AUTH_SIGNING_KEYS ?? "").length > 0;

if (!USABLE)
  console.warn(
    "[calendar-events-cost] SKIPPED — needs DATABASE_URL, APP_DATABASE_URL (scratch), SEED_ORG_ID, AUTH_SIGNING_KEYS",
  );

const describeIfSeeded = USABLE ? describe : describe.skip;

const CALENDAR_QUERY = {
  start: "2026-08-01T00:00:00.000Z",
  end: "2026-10-01T00:00:00.000Z",
};

const SAMPLES = 20;
const LATENCY_P95_BUDGET_MS = 800;
const DB_CALLS_LARGE_BUDGET = 60;
const DB_CALLS_SMALL_BUDGET = 45;

function percentile(sorted: number[], p: number): number {
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

describeIfSeeded("GET /calendar/events — focused cost guard", () => {
  let harness: SeededE2eApp;
  let downstream: DownstreamCounter;

  beforeAll(async () => {
    harness = await createSeededE2eApp({ mirrorHttpStack: true });
    downstream = new DownstreamCounter();
    const addr = harness.app.getHttpServer().address();
    if (addr && typeof addr === "object") downstream.excludeLoopbackPort(addr.port);
  });

  afterAll(async () => {
    await harness.close();
  });

  async function findActiveUserId(orgId: string): Promise<string> {
    const row = await harness.seedDb.query.organizationMembers.findFirst({
      where: eq(organizationMembers.orgId, orgId),
      columns: { userId: true },
    });
    if (!row) throw new Error(`No active member in org ${orgId}`);
    return row.userId;
  }

  async function runSamples(
    orgId: string,
  ): Promise<{ latencies: number[]; dbCallCounts: number[] }> {
    const userId = await findActiveUserId(orgId);
    const token = await signSeededToken(harness, userId, orgId);

    const latencies: number[] = [];
    const dbCallCounts: number[] = [];

    for (let i = 0; i < SAMPLES; i++) {
      queryTelemetry.reset();
      downstream.reset();

      const t0 = Date.now();
      const res = await request(harness.app.getHttpServer())
        .get("/v1/calendar/events")
        .query(CALENDAR_QUERY)
        .set("Authorization", `Bearer ${token}`);
      const elapsed = Date.now() - t0;

      const snap = queryTelemetry.snapshot();
      const dbCalls = snap["db.query.execute"].count;

      expect(res.status).toBe(200);
      latencies.push(elapsed);
      dbCallCounts.push(dbCalls);
    }

    return { latencies, dbCallCounts };
  }

  it("large tenant: p95 latency ≤ 800 ms and DB calls within budget", async () => {
    const { latencies, dbCallCounts } = await runSamples(LARGE_ORG);

    const sorted = [...latencies].sort((a, b) => a - b);
    const p95 = percentile(sorted, 95);
    const maxDb = Math.max(...dbCallCounts);

    console.info(
      `[large-tenant] p50=${percentile(sorted, 50)}ms p95=${p95}ms p99=${percentile(sorted, 99)}ms` +
        ` | db max=${maxDb} min=${Math.min(...dbCallCounts)}`,
    );

    expect(p95).toBeLessThanOrEqual(LATENCY_P95_BUDGET_MS);
    expect(maxDb).toBeLessThanOrEqual(DB_CALLS_LARGE_BUDGET);
  });

  if (SMALL_ORG.length > 0)
    it("small tenant: p95 latency ≤ 800 ms and DB calls within budget", async () => {
      const { latencies, dbCallCounts } = await runSamples(SMALL_ORG);

      const sorted = [...latencies].sort((a, b) => a - b);
      const p95 = percentile(sorted, 95);
      const maxDb = Math.max(...dbCallCounts);

      console.info(
        `[small-tenant] p50=${percentile(sorted, 50)}ms p95=${p95}ms p99=${percentile(sorted, 99)}ms` +
          ` | db max=${maxDb} min=${Math.min(...dbCallCounts)}`,
      );

      expect(p95).toBeLessThanOrEqual(LATENCY_P95_BUDGET_MS);
      expect(maxDb).toBeLessThanOrEqual(DB_CALLS_SMALL_BUDGET);
    });
});
