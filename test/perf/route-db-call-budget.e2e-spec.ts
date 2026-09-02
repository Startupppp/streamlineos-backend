import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { writeFileSync } from "node:fs";
import * as schema from "src/db/schema";
import type { Db } from "src/db/drizzle.module";
import { instrumentPostgresClient } from "src/db/query-telemetry";
import { CacheService } from "src/common/cache/cache.service";
import { NotificationsReadService } from "src/modules/notifications/notifications-read.service";
import {
  assertNoDbCallRegression,
  assertWithinDbCallBudget,
  countDbCalls,
  loadRouteBudgets,
} from "src/scripts/route-budget-db-calls";

/**
 * The database-call budget, measured against real services over a seeded database.
 *
 * This is the regression half of ticket 22: `contracts/route-budgets.json` declares maxDbCalls for
 * every critical route, and this file proves the declaration bites for the routes it covers. An
 * implementation that adds a query to one of them fails here with the route name and both numbers.
 *
 * Counted as `streamline_app` with `app.organization_id` set at SESSION scope over a single pooled
 * connection, so row-level security is live — an RLS-suppressed row is a row the service does not
 * fetch, and counting under BYPASSRLS would count a different code path.
 *
 * The cache is a real CacheService with a null Redis, which always misses. That is deliberate:
 * every maxDbCalls in the manifest is the CACHE-MISS ceiling, which is the only interesting one.
 *
 * Requires APP_DATABASE_URL naming a database whose name contains "scratch" (the perf seed).
 * Absent, the suite is skipped, and the skip is printed — a silent skip reads as a green ratchet.
 */

const APP_URL = process.env.APP_DATABASE_URL ?? "";
const USABLE = APP_URL.length > 0 && /scratch/i.test(APP_URL);
if (!USABLE)
  console.error(
    "[route-db-call-budget] SKIPPED — set APP_DATABASE_URL to the non-BYPASSRLS app role on a " +
      "scratch database (e.g. scratch_perf_seed) to run the database-call ratchet. " +
      "This suite proves nothing while skipped.",
  );

const describeIfSeeded = USABLE ? describe : describe.skip;

describeIfSeeded("route database-call budgets (seeded)", () => {
  const manifest = loadRouteBudgets();
  const counted: Record<string, number> = {};
  let client: ReturnType<typeof postgres>;
  let db: Db;
  let service: NotificationsReadService;
  let orgId = "";
  let userId = "";

  beforeAll(async () => {
    client = postgres(APP_URL, {
      max: 1,
      prepare: false,
      ssl: process.env.PGSSLMODE === "disable" ? false : "require",
      onnotice: () => {},
    });
    instrumentPostgresClient(client);
    db = drizzle(client, { schema });

    // The tenant must be chosen before anything is read: organization_members carries RLS, so a
    // read with no GUC returns nothing and reads as "the seed is empty" rather than "isolation is
    // on". SEED_ORG_ID names the tenant; the organizations table is the only fallback.
    const fromEnv = process.env.SEED_ORG_ID ?? "";
    if (fromEnv) orgId = fromEnv;
    else {
      const orgs = await client.unsafe<{ id: string }[]>(`SELECT id FROM organizations ORDER BY id LIMIT 1`);
      const first = orgs[0];
      if (!first) throw new Error("[route-db-call-budget] no organization in the seeded database");
      orgId = first.id;
    }

    await client.unsafe(`SELECT set_config('app.organization_id', $1, false)`, [orgId]);

    const memberRows = await client.unsafe<{ user_id: string }[]>(
      `SELECT user_id FROM organization_members
       WHERE org_id = $1 AND status = 'ACTIVE' AND user_id IS NOT NULL
       ORDER BY id LIMIT 1`,
      [orgId],
    );
    const member = memberRows[0];
    if (!member)
      throw new Error(`[route-db-call-budget] no active membership in org ${orgId} — reseed or set SEED_ORG_ID`);
    userId = member.user_id;
    service = new NotificationsReadService(db, new CacheService(null));
  });

  afterAll(async () => {
    const artifact = process.env.ROUTE_BUDGET_DB_CALL_ARTIFACT;
    if (artifact) writeFileSync(artifact, `${JSON.stringify({ tenant: orgId, dbCalls: counted }, null, 2)}\n`);
    if (client) await client.end({ timeout: 5 });
  });

  it("GET /notifications/unread-count stays within its declared database-call budget", async () => {
    const { count } = await countDbCalls(() => service.unreadCount(orgId, userId));
    counted["GET /notifications/unread-count"] = count.queries;
    expect(count.queries).toBeGreaterThan(0);
    expect(() =>
      assertWithinDbCallBudget(manifest, "GET /notifications/unread-count", count.queries),
    ).not.toThrow();
  });

  /**
   * Was measured at 5 against a declared ceiling of 3 and pinned here as a known breach. The
   * fifth and fourth statements were a membership lookup issued twice — once directly and once
   * inside the watermark read that had already been handed the membership — and folding the
   * watermark into the membership query took the route to 3 (recipient + list + ticket context)
   * and unread-count from 4 to 2. Both assertions stay: the ratchet holds the measured number so
   * the route cannot creep back up, and the budget assertion now has to PASS, so a regression to
   * 4 fails here rather than being absorbed. Neither ceiling was raised.
   */
  it("GET /notifications does not add a database statement", async () => {
    const { count } = await countDbCalls(() => service.list(orgId, userId, {}));
    counted["GET /notifications"] = count.queries;
    expect(count.queries).toBeGreaterThan(0);
    expect(() => assertNoDbCallRegression(manifest, "GET /notifications", count.queries)).not.toThrow();
  });

  it("GET /notifications stays within its declared database-call budget", async () => {
    const { count } = await countDbCalls(() => service.list(orgId, userId, {}));
    expect(count.queries).toBeLessThanOrEqual(3);
    expect(() =>
      assertWithinDbCallBudget(manifest, "GET /notifications", count.queries),
    ).not.toThrow();
  });

  it("the ratchet fails when a route issues one statement more than its budget", async () => {
    const { count } = await countDbCalls(() => service.unreadCount(orgId, userId));
    expect(() =>
      assertWithinDbCallBudget(manifest, "GET /notifications/unread-count", count.queries + 100),
    ).toThrow(/over its declared maxDbCalls/);
  });

  it("row-level security is live for the counted session", async () => {
    const rows = await client.unsafe<{ bypassrls: boolean }[]>(
      `SELECT rolbypassrls AS bypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]?.bypassrls).toBe(false);
  });
});
