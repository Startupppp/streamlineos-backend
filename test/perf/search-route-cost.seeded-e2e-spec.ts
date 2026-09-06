import postgres from "postgres";
import request from "supertest";
import { requiresTls } from "src/db/pool.config";
import { createSeededE2eApp, signSeededToken, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { queryTelemetry } from "src/db/query-telemetry";
import { REDIS } from "src/common/cache/cache.service";

/**
 * Focused cost gate for GET /search.
 *
 * Measured defect (2026-09-05): 19 SQL statements for an empty result set on the
 * reference tenant — exceeding the declared ceiling of maxRequestDbCalls: 14.
 *
 * Fix (2026-09-06): one shared module-map round-trip across all entity types
 * (down from 5), one combined UNION ALL probe for all enabled SDF kinds (down
 * from 5 separate calls), zero hydration queries when the probe returns 0 ids,
 * per-request memos for getUserDeniedModules + getPlanLockedModules so the two
 * concurrent moduleAvailability calls each issue 1 DB round-trip (not 2), and
 * the redundant class-level @UseGuards(JwtAuthGuard) removed from
 * SearchController — JwtAuthGuard is already a global APP_GUARD; the local copy
 * created a second instance with its own empty revocationCache, causing
 * isAccountActive + fetchMembershipState to each issue a second DB round-trip
 * per request (auth-scoped keys bypass outage memoization so no in-process dedup
 * was possible).
 *
 * This spec boots the same in-process NestJS stack as the full route-budget harness
 * but only instruments one route. Redis is off by design (no override) so every
 * count is the cache-MISS ceiling. The in-memory EntitlementsService cache and
 * permResolveInFlight dedup still work, reducing the permission leg to ~4 queries.
 *
 * Run via:
 *   MSYS_NO_PATHCONV=1 pnpm exec tsx test/helpers/run-seeded-e2e.ts scratch_local \
 *     test/perf/search-route-cost.seeded-e2e-spec.ts
 */

jest.setTimeout(300_000);

const OWNER_URL = process.env.DATABASE_URL ?? "";
const APP_URL = process.env.APP_DATABASE_URL ?? "";
const REFERENCE_ORG =
  process.env.SEED_ORG_ID ?? "aaaaaaaa-1111-0000-0000-000000000001";
const MINORITY_ORG =
  process.env.SEED_MINORITY_ORG_ID ?? "aaaaaaaa-1111-0000-0000-000000000002";

const DB_CALLS_CEILING = 14;
const SAMPLES = 20;

describe("GET /search — request-level db call budget", () => {
  let seeded: SeededE2eApp;
  let baseUrl: string;
  let owner: ReturnType<typeof postgres>;

  beforeAll(async () => {
    seeded = await createSeededE2eApp({ mirrorHttpStack: true });
    await seeded.app.listen(0);
    const address = seeded.app.getHttpServer().address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;
    if (!port)
      throw new Error("[search-route-cost] app did not bind a port");
    baseUrl = `http://127.0.0.1:${String(port)}`;

    owner = postgres(OWNER_URL, {
      max: 1,
      prepare: false,
      ssl: requiresTls(OWNER_URL) ? "require" : false,
      onnotice: () => {},
    });
  });

  afterAll(async () => {
    await owner.end();
    if (seeded) await seeded.close();
  });

  async function resolveActiveMember(orgId: string): Promise<string> {
    const rows = await owner.unsafe<{ user_id: string }[]>(
      `SELECT user_id FROM organization_members
       WHERE org_id = $1 AND status = 'ACTIVE' AND user_id IS NOT NULL
       ORDER BY is_owner DESC, id ASC LIMIT 1`,
      [orgId],
    );
    const userId = rows[0]?.user_id;
    if (!userId)
      throw new Error(`[search-route-cost] no active member in org ${orgId}`);
    return userId;
  }

  async function measureSearch(orgId: string, token: string): Promise<number> {
    queryTelemetry.reset();
    const res = await request(baseUrl)
      .get("/search")
      .query({ q: "sdf", limit: "5" })
      .set("Authorization", `Bearer ${token}`)
      .timeout({ deadline: 30_000, response: 30_000 });
    const snapshot = queryTelemetry.snapshot();
    if (res.status !== 200)
      throw new Error(
        `[search-route-cost] expected 200, got ${String(res.status)} for org ${orgId}`,
      );
    return snapshot["db.query.execute"].count;
  }

  it("Redis is not wired (every count is the cache-MISS ceiling)", () => {
    expect(seeded.app.get(REDIS, { strict: false })).toBeNull();
  });

  it.each([
    { label: "reference tenant (89.9%)", org: REFERENCE_ORG },
    { label: "minority tenant (0.9%)", org: MINORITY_ORG },
  ])(
    `$label: all ${SAMPLES} samples are ≤ ${DB_CALLS_CEILING} db calls`,
    async ({ org }) => {
      const userId = await resolveActiveMember(org);
      const token = await signSeededToken(seeded, userId, org);

      const counts: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        counts.push(await measureSearch(org, token));
      }

      const max = Math.max(...counts);
      const distinct = [...new Set(counts)].sort((a, b) => a - b);
      console.log(
        `[search-route-cost] org=${org} counts=${JSON.stringify(distinct)} max=${String(max)}`,
      );

      expect(max).toBeLessThanOrEqual(DB_CALLS_CEILING);
    },
  );
});
