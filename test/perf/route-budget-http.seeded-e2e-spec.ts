import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import request from "supertest";
import postgres from "postgres";
import { createSeededE2eApp, signSeededToken, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import {
  DownstreamCounter,
  contentHash,
  controlProbe,
  gcAvailable,
  measureOnce,
  summarise,
  tally,
  withDeadline,
  type ControlProbe,
  type RequestSample,
  type RouteMeasurement,
  type RunTally,
} from "test/perf/route-budget-http-harness";
import { buildRoutePlan, type RouteFixtures, type RoutePlanEntry } from "test/perf/route-budget-http-plan";
import { loadRouteBudgets } from "src/scripts/route-budget-db-calls";

/**
 * Ticket 22, box 2: the four end-to-end ceilings measured through the HTTP stack.
 *
 * `run-read-cost-budgets.mjs` EXPLAINs one statement. It cannot see the other statements a request
 * issues, the bytes it serialises, the provider calls it makes or the heap it holds, which is why
 * `measure-route-budgets.mjs` refuses to fill `measuredLatencyP95Ms` from it — a 5.7 ms database
 * read inside a 300 ms end-to-end ceiling would be a false pass. This file is the instrument that
 * refusal was waiting for.
 *
 * WHAT MAKES A NUMBER HERE TRUSTWORTHY
 *
 *   - The app runs on APP_DATABASE_URL as the NON-OWNER role, asserted at `beforeAll` against
 *     `pg_roles`. Measured as the owner, BYPASSRLS removes the RLS predicate that costs the most
 *     and every figure below is a lower bound on a plan production never runs.
 *   - Redis is off, so every count is the CACHE-MISS ceiling. Permission resolution, the module
 *     map and the org placement all hit the database on every request. That is the number a budget
 *     has to hold; a cache-hit number would be a budget for a warm day.
 *   - Two tenants at opposite ends of the seed's skew. The 89.9% tenant and a minority tenant pick
 *     different plans for identical queries here (1,237 buffers versus 6), so a single-tenant
 *     reading has already produced a wrong verdict once in this release.
 *   - Only a 2xx counts. A 403 measures the guard and a 404 measures the router; recording either
 *     as the route's latency would put a number in the manifest describing work production never
 *     does.
 *
 * FOUR PROPERTIES ADDED AFTER WATCHING HARNESSES IN THIS RELEASE LIE
 *
 *   control probe   Before and after every tenant's capture, one request WITH the token must
 *                   answer 200 and one WITHOUT it must answer 401/403. Two harnesses here reported
 *                   clean results while every request was failing, because a uniform refusal is
 *                   indistinguishable from a uniform success to an instrument that only records
 *                   what it receives. A failed probe FAILS THE RUN rather than producing a table.
 *   deadline        Every send races a timer. A driver with no deadline parked a previous agent
 *                   2 h 31 m at 0% CPU after 10 of 24 route pairs and silently halved the sample.
 *                   A wedged route lands in `routeFailures`.
 *   subject hash    A commit SHA does not pin evidence here — one agent measured its own catalog
 *                   changing shape mid-capture while the SHA still read "current". The row counts
 *                   the routes read are hashed before and after, and the tables this harness
 *                   itself writes are declared so that expected movement is not reported as drift.
 *   refusal count   Reported beside the results, so an unmeasured route is VISIBLY unmeasured.
 *
 * WHY THE DATABASE-CALL COUNT IS ITS OWN FIELD
 *
 * `maxDbCalls` is the HANDLER's statement count — what `route-db-call-budget.e2e-spec.ts` counts
 * around a service call, and what the five `counted-call-path` entries in the manifest mean. An
 * HTTP request additionally pays for authentication, permission resolution and module entitlement,
 * so its count is a strict superset. Writing the superset into `maxDbCalls` would silently raise
 * every one of those ceilings and turn the service-level ratchet into a test that cannot fail.
 * The end-to-end count is therefore recorded as `measuredRequestDbCalls` against its own
 * `maxRequestDbCalls`, and the two instruments stay distinguishable.
 */

jest.setTimeout(7_200_000);

const OWNER_URL = process.env.DATABASE_URL ?? "";
const APP_URL = process.env.APP_DATABASE_URL ?? "";
const REFERENCE_ORG = process.env.SEED_ORG_ID ?? "";
const MINORITY_ORG = process.env.SEED_MINORITY_ORG_ID ?? "";
const ARTIFACT = process.env.ROUTE_BUDGET_HTTP_ARTIFACT ?? "";
const SAMPLES = Number(process.env.ROUTE_BUDGET_HTTP_SAMPLES ?? "40");
const WRITE_SAMPLES = Number(process.env.ROUTE_BUDGET_HTTP_WRITE_SAMPLES ?? "12");
const HEAP_SAMPLES = Number(process.env.ROUTE_BUDGET_HTTP_HEAP_SAMPLES ?? "5");
const WARMUP = Number(process.env.ROUTE_BUDGET_HTTP_WARMUP ?? "3");
const DEADLINE_MS = Number(process.env.ROUTE_BUDGET_HTTP_DEADLINE_MS ?? "30000");
const ONLY = process.env.ROUTE_BUDGET_HTTP_ONLY ?? "";

const USABLE =
  OWNER_URL.length > 0 &&
  APP_URL.length > 0 &&
  /scratch/i.test(APP_URL) &&
  REFERENCE_ORG.length > 0 &&
  (process.env.AUTH_SIGNING_KEYS ?? "").length > 0;

if (!USABLE)
  console.error(
    "[route-budget-http] SKIPPED — this suite proves nothing while skipped. It needs:\n" +
      "  DATABASE_URL       owner role on a scratch database (seeding + fixture lookup)\n" +
      "  APP_DATABASE_URL   the NON-OWNER app role on the SAME scratch database (the app's own pool)\n" +
      "  SEED_ORG_ID        the reference tenant; SEED_MINORITY_ORG_ID adds a second profile\n" +
      "  AUTH_SIGNING_KEYS  a LOCAL PLACEHOLDER Ed25519 keyring — never a real credential\n" +
      "  ROUTE_BUDGET_HTTP_ARTIFACT  where to write the measurement for measure-route-budgets.mjs",
  );

const describeIfSeeded = USABLE ? describe : describe.skip;

interface SubjectSnapshot {
  readonly counts: Readonly<Record<string, number>>;
  readonly hash: string;
}

interface TenantRun {
  tenant: string;
  profile: string;
  userId: string;
  fixtures: RouteFixtures;
  fixtureHash: string;
  controlBefore: ControlProbe;
  controlAfter: ControlProbe;
  subjectBefore: SubjectSnapshot;
  subjectAfter: SubjectSnapshot;
  subjectDrift: string[];
  subjectStable: boolean;
  tally: RunTally;
  routes: Record<string, RouteMeasurement>;
}

/**
 * The subject: the rows the plan's reads actually walk.
 *
 * Counted per tenant before and after the capture and hashed, so a database that changed shape
 * mid-run says so instead of averaging two populations into one number.
 */
const SUBJECT_TABLES = [
  "build.projects",
  "build.sprints",
  "build.tickets",
  "calendar_events",
  "event_attendees",
  "notifications",
  "chat_channels",
  "chat_channel_members",
  "chat_messages",
  "kb_spaces",
  "kb_pages",
  "contacts",
  "leads",
  "deals",
  "clients",
  "business_parties",
  "invoices",
  "inv_products",
  "inv_product_variants",
  "inv_stock_levels",
  "inv_stock_transactions",
  "support_tickets",
  "attendance",
  "timesheets",
  "payroll_runs",
  "organization_members",
] as const;

/**
 * Tables this harness itself inserts into, from the plan's own POST entries.
 *
 * Declaring them is the difference between "the database drifted under me" and "I wrote to it on
 * purpose". Movement anywhere else is drift and invalidates the capture; movement here is expected
 * and is still recorded, because the SIZE of the movement is how you notice a write path fanning
 * out further than the plan says it does.
 */
const HARNESS_WRITES = new Set<string>([
  "build.tickets",
  "chat_messages",
  "timesheets",
  "leads",
  "deals",
  "invoices",
  "support_tickets",
  "notifications",
  "business_parties",
]);

function commit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function workingTreeDirty(): boolean | null {
  try {
    return execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
  } catch {
    return null;
  }
}

function journalEntries(): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync("migrations/meta/_journal.json", "utf8"));
    if (parsed !== null && typeof parsed === "object" && "entries" in parsed) {
      const entries = (parsed as { entries: unknown }).entries;
      if (Array.isArray(entries)) return entries.length;
    }
    return null;
  } catch {
    return null;
  }
}

function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, "").split("?")[0] ?? "";
  } catch {
    return "";
  }
}

describeIfSeeded("route budgets over the HTTP stack (seeded)", () => {
  const manifest = loadRouteBudgets();
  const downstream = new DownstreamCounter();
  const runs: TenantRun[] = [];
  let seeded: SeededE2eApp;
  let baseUrl = "";
  let owner: ReturnType<typeof postgres>;
  let appProbe: ReturnType<typeof postgres>;
  let cronSecret = "";
  let appliedMigrations: number | null = null;

  beforeAll(async () => {
    // A local placeholder, generated here rather than read from a deployment: the cron routes are
    // @Public() and gated on this value alone, so borrowing the real one to take a measurement
    // would put a production credential in a test process for no gain.
    cronSecret = `t22-local-${randomUUID()}`;
    process.env.CRON_SECRET = cronSecret;

    seeded = await createSeededE2eApp({ mirrorHttpStack: true });
    await seeded.app.listen(0);
    const address = seeded.app.getHttpServer().address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    if (!port) throw new Error("[route-budget-http] the harness app did not bind a port");
    baseUrl = `http://127.0.0.1:${String(port)}`;
    downstream.excludeLoopbackPort(port);
    downstream.install();

    owner = postgres(OWNER_URL, { max: 2, prepare: false, ssl: false, onnotice: () => {} });
    appProbe = postgres(APP_URL, { max: 1, prepare: false, ssl: false, onnotice: () => {} });

    const applied = await owner.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    appliedMigrations = applied[0]?.n ?? null;
  });

  afterAll(async () => {
    downstream.restore();
    if (ARTIFACT && runs.length > 0) {
      const journal = journalEntries();
      writeFileSync(
        ARTIFACT,
        `${JSON.stringify(
          {
            method: "http-harness",
            generatedAt: new Date().toISOString(),
            commit: commit(),
            workingTreeDirty: workingTreeDirty(),
            database: databaseName(APP_URL),
            appliedMigrations,
            journalEntries: journal,
            atHead: appliedMigrations !== null && journal !== null && appliedMigrations === journal,
            role: "streamline_app (rolbypassrls = false, RLS live)",
            cache: "Redis disabled — every count is the cache-miss ceiling",
            compression: "off — responseBytes is the uncompressed payload the application produced",
            samples: SAMPLES,
            writeSamples: WRITE_SAMPLES,
            heapSamples: HEAP_SAMPLES,
            warmup: WARMUP,
            deadlineMs: DEADLINE_MS,
            gcAvailable: gcAvailable(),
            memoryNote: gcAvailable()
              ? "heapUsed above a post-GC baseline"
              : "REFUSED — no --expose-gc, so a heap reading here would be the previous request's residue, not this route's",
            tenants: runs,
          },
          null,
          2,
        )}\n`,
      );
    }
    if (appProbe) await appProbe.end({ timeout: 5 });
    if (owner) await owner.end({ timeout: 5 });
    if (seeded) await seeded.close();
  });

  it("runs the application against a non-BYPASSRLS role", async () => {
    const rows = await appProbe.unsafe<{ bypassrls: boolean; role: string }[]>(
      `SELECT rolbypassrls AS bypassrls, current_user AS role FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]?.bypassrls).toBe(false);
  });

  it("row-level security is enabled on the tables being measured", async () => {
    const rows = await appProbe.unsafe<{ on: number }[]>(
      `SELECT count(*)::int AS on FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relrowsecurity AND n.nspname IN ('public','build')`,
    );
    expect(Number(rows[0]?.on ?? 0)).toBeGreaterThan(0);
  });

  it("the database it is measuring is at journal head", () => {
    const journal = journalEntries();
    process.stderr.write(
      `[route-budget-http] database=${databaseName(APP_URL)} applied=${String(appliedMigrations)} journal=${String(journal)}\n`,
    );
    expect(appliedMigrations).toBe(journal);
  });

  it("every plan entry names a declared budget, and every route budget has a plan entry", () => {
    const plan = buildRoutePlan(EMPTY_FIXTURES);
    const planKeys = new Set(plan.map((entry) => entry.key));
    const budgetKeys = Object.keys(manifest.budgets);
    const unknown = [...planKeys].filter((k) => !budgetKeys.includes(k));
    const uncovered = budgetKeys.filter((k) => !planKeys.has(k));
    expect({ unknown, uncovered }).toEqual({ unknown: [], uncovered: [] });
  });

  const profiles: { org: string; profile: string }[] = [{ org: REFERENCE_ORG, profile: "reference" }];
  if (MINORITY_ORG) profiles.push({ org: MINORITY_ORG, profile: "minority" });

  for (const { org, profile } of profiles) {
    it(`measures every declared route against tenant ${org} (${profile})`, async () => {
      const userId = await resolveOwnerUser(owner, org);
      const fixtures = await resolveFixtures(owner, org, userId);
      const mintToken = async (): Promise<string> => signSeededToken(seeded, userId, org);

      // The control probe decides whether this tenant is allowed to produce numbers at all.
      const controlBefore = await probeControl(baseUrl, await mintToken());
      if (!controlBefore.ok)
        throw new Error(
          `[route-budget-http] REFUSING TO SCORE tenant ${org} (${profile}): ${controlBefore.failure ?? "unknown"}`,
        );

      const subjectBefore = await snapshotSubject(owner, org);
      const plan = buildRoutePlan(fixtures);
      const routes: Record<string, RouteMeasurement> = {};

      for (const entry of plan) {
        if (ONLY && !entry.key.includes(ONLY)) continue;
        // The signing key issues a 10-minute token and a full capture outruns it, so the token is
        // re-minted per route. Without this the run degrades into 401s partway through and records
        // them as "the route is broken".
        routes[entry.key] = await measureRoute(entry, await mintToken(), cronSecret, baseUrl, downstream);
        const m = routes[entry.key];
        process.stderr.write(
          `  ${m?.status === "measured" ? "OK  " : m?.status === "failed" ? "FAIL" : "--  "}${entry.key.padEnd(56)} ` +
            `${m?.status === "measured" ? `p95=${String(m.latencyMs?.p95)}ms db=${String(m.dbCalls)} bytes=${String(m.responseBytes)} down=${String(m.downstreamCalls)} mem=${String(m.memoryMb)}` : (m?.reason ?? "")}\n`,
        );
      }

      const subjectAfter = await snapshotSubject(owner, org);
      const subjectDrift = Object.keys(subjectBefore.counts).filter(
        (table) => !HARNESS_WRITES.has(table) && subjectBefore.counts[table] !== subjectAfter.counts[table],
      );
      const controlAfter = await probeControl(baseUrl, await mintToken());
      const counted = tally(routes);

      runs.push({
        tenant: org,
        profile,
        userId,
        fixtures,
        fixtureHash: contentHash(fixtures),
        controlBefore,
        controlAfter,
        subjectBefore,
        subjectAfter,
        subjectDrift,
        subjectStable: subjectDrift.length === 0,
        tally: counted,
        routes,
      });

      process.stderr.write(
        `[route-budget-http] ${profile} tenant ${org}: ` +
          `${String(counted.measured)} measured / ${String(counted.refused)} refused / ${String(counted.failed)} failed ` +
          `of ${String(counted.total)} · subject ${subjectDrift.length === 0 ? "STABLE" : `DRIFTED (${subjectDrift.join(", ")})`}\n`,
      );
      for (const failure of counted.routeFailures) process.stderr.write(`  ROUTE FAILURE  ${failure}\n`);

      // A capture whose control probe stopped holding partway through is not a capture.
      expect(controlAfter.ok).toBe(true);
      expect(counted.measured).toBeGreaterThan(0);
    });
  }
});

const EMPTY_FIXTURES: RouteFixtures = {
  projectId: null,
  channelId: null,
  spaceId: null,
  payrollRunId: null,
  clientId: null,
  ticketId: null,
  projectStatusName: null,
};

/**
 * `GET /me/access` is the probe route: it is authenticated, it is the route the frontend's entire
 * gating layer depends on, and it 401s without a credential — which is what makes the paired
 * anonymous half meaningful.
 */
async function probeControl(baseUrl: string, token: string): Promise<ControlProbe> {
  const call = async (headers: Record<string, string>): Promise<{ status: number; bytes: number; body: string }> => {
    let req = request(baseUrl).get("/me/access").timeout({ deadline: DEADLINE_MS, response: DEADLINE_MS });
    for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
    const res = await req.ok(() => true);
    const text = typeof res.text === "string" ? res.text : JSON.stringify(res.body ?? null);
    return { status: res.status, bytes: Buffer.byteLength(text, "utf8"), body: text };
  };
  return controlProbe(
    () => call({ Authorization: `Bearer ${token}` }),
    () => call({}),
    { deadlineMs: DEADLINE_MS },
  );
}

async function snapshotSubject(sql: ReturnType<typeof postgres>, orgId: string): Promise<SubjectSnapshot> {
  const counts: Record<string, number> = {};
  for (const table of SUBJECT_TABLES) {
    const exists = await sql.unsafe<{ ok: string | null }[]>(`SELECT to_regclass($1)::text AS ok`, [table] as never[]);
    if (!exists[0]?.ok) continue;
    try {
      const rows = await sql.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`,
        [orgId] as never[],
      );
      counts[table] = Number(rows[0]?.n ?? 0);
    } catch {
      continue;
    }
  }
  return { counts, hash: contentHash(counts) };
}

async function resolveOwnerUser(sql: ReturnType<typeof postgres>, orgId: string): Promise<string> {
  const rows = await sql.unsafe<{ user_id: string }[]>(
    `SELECT user_id FROM organization_members
     WHERE org_id = $1 AND status = 'ACTIVE' AND user_id IS NOT NULL
     ORDER BY is_owner DESC, id ASC LIMIT 1`,
    [orgId],
  );
  const userId = rows[0]?.user_id;
  if (!userId) throw new Error(`[route-budget-http] no active membership in org ${orgId}`);
  return userId;
}

/**
 * Fixtures come from the tenant's own rows.
 *
 * A project id borrowed from the majority tenant is a 404 in the minority one, and a 404 has a
 * cost that is not the route's. A missing fixture yields null, which the plan turns into a
 * declared `unattemptable` rather than a request against an id that does not exist.
 */
async function resolveFixtures(
  sql: ReturnType<typeof postgres>,
  orgId: string,
  userId: string,
): Promise<RouteFixtures> {
  const one = async (query: string, params: unknown[]): Promise<number | null> => {
    const rows = await sql.unsafe<{ id: number | string }[]>(query, params as never[]);
    const id = rows[0]?.id;
    return id === undefined ? null : Number(id);
  };

  const projectId = await one(
    `SELECT id FROM build.projects WHERE org_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1`,
    [orgId],
  );
  const statusRows =
    projectId === null
      ? []
      : await sql.unsafe<{ name: string }[]>(
          `SELECT name FROM build.project_statuses WHERE org_id = $1 AND project_id = $2 ORDER BY "order" LIMIT 1`,
          [orgId, projectId] as never[],
        );

  return {
    projectId,
    projectStatusName: statusRows[0]?.name ?? null,
    channelId: await one(
      `SELECT c.id FROM chat_channels c
         JOIN chat_channel_members m ON m.channel_id = c.id AND m.org_id = c.org_id
         JOIN organization_members om ON om.id = m.membership_id AND om.org_id = c.org_id
       WHERE c.org_id = $1 AND om.user_id = $2
       ORDER BY c.id LIMIT 1`,
      [orgId, userId],
    ),
    spaceId: await one(`SELECT id FROM kb_spaces WHERE org_id = $1 ORDER BY id LIMIT 1`, [orgId]),
    payrollRunId: await one(`SELECT id FROM payroll_runs WHERE org_id = $1 ORDER BY id LIMIT 1`, [orgId]),
    clientId: await one(`SELECT id FROM clients WHERE org_id = $1 ORDER BY id LIMIT 1`, [orgId]),
    ticketId: await one(`SELECT id FROM build.tickets WHERE org_id = $1 ORDER BY id LIMIT 1`, [orgId]),
  };
}

function unmeasured(reason: string, status: "unmeasured" | "failed"): RouteMeasurement {
  return {
    status,
    httpStatus: null,
    reason,
    samples: 0,
    latencyMs: null,
    dbCalls: null,
    dbCallsVaried: null,
    gucCalls: null,
    downstreamCalls: null,
    responseBytes: null,
    memoryMb: null,
  };
}

async function measureRoute(
  entry: RoutePlanEntry,
  token: string,
  cronSecret: string,
  baseUrl: string,
  downstream: DownstreamCounter,
): Promise<RouteMeasurement> {
  if (entry.unattemptable) return unmeasured(entry.unattemptable, "unmeasured");

  const send = async (): Promise<{ status: number; bytes: number; body: string }> => {
    const agent = request(baseUrl);
    let req = entry.method === "get" ? agent.get(entry.path) : agent.post(entry.path);
    req = req.timeout({ deadline: DEADLINE_MS, response: DEADLINE_MS }).ok(() => true);
    req = entry.auth === "cron" ? req.set("Authorization", `Bearer ${cronSecret}`) : req.set("Authorization", `Bearer ${token}`);
    // @Idempotent routes 400 without this, and the error reads like a body validation failure.
    // A fresh key per sample, because a replayed key measures the replay path, not the write.
    if (entry.idempotent === true) req = req.set("Idempotency-Key", randomUUID());
    if (entry.query) req = req.query(entry.query);
    if (entry.body !== undefined) req = req.send(entry.body() as object);
    const res = await req;
    const text = typeof res.text === "string" ? res.text : JSON.stringify(res.body ?? null);
    return { status: res.status, bytes: Buffer.byteLength(text, "utf8"), body: text };
  };

  let lastBody = "";
  const shaped = async (): Promise<{ status: number; bytes: number }> => {
    // Two deadlines, deliberately. superagent's aborts the socket, which is what actually frees
    // the run; `withDeadline` is the backstop for the case superagent's own promise never settles,
    // which is exactly the shape of the 2 h 31 m park this exists to prevent.
    const out = await withDeadline(send, DEADLINE_MS + 5_000, entry.key);
    lastBody = out.body;
    return { status: out.status, bytes: out.bytes };
  };

  try {
    for (let i = 0; i < WARMUP; i++) {
      const warm = await shaped();
      if (warm.status < 200 || warm.status >= 300)
        return summarise(
          [{ status: warm.status, ms: 0, bytes: warm.bytes, dbCalls: 0, gucCalls: 0, downstreamCalls: 0, heapMb: null }],
          [],
          lastBody.slice(0, 300),
        );
    }

    const count = entry.method === "post" ? WRITE_SAMPLES : SAMPLES;
    const latency: RequestSample[] = [];
    for (let i = 0; i < count; i++) latency.push(await measureOnce(shaped, downstream, { measureHeap: false }));

    // Heap is a separate pass: a forced collection between samples costs more wall clock than the
    // requests do, so measuring both in one pass would report a latency distribution shaped by the
    // garbage collector rather than by the route.
    const heap: RequestSample[] = [];
    for (let i = 0; i < HEAP_SAMPLES; i++) heap.push(await measureOnce(shaped, downstream, { measureHeap: true }));

    return summarise(latency, heap, lastBody.slice(0, 300));
  } catch (error) {
    return unmeasured(error instanceof Error ? error.message : String(error), "failed");
  }
}
