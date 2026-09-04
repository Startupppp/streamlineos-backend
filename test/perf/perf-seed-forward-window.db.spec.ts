/**
 * The production-shaped perf seed must hold a FORWARD window, not only a history.
 *
 * WHAT WAS WRONG. Both seeding layers generate every dated row backwards from the moment
 * the seed ran: `seed-heavy-query-load.mjs` writes calendar events at
 * `now() - ((g % 730) || ' days')`, and `seed-perf-scratch.mjs` writes leave requests from
 * `CURRENT_DATE - ((g % 200) || ' days')` to one day later. Two read-cost budgets read the
 * other direction — `dashboard-personal-calendar-events` filters `start_date >= NOW()` and
 * `dashboard-leaves-today` filters `start_date <= today AND end_date >= today` — so from the
 * day after a seed run they measured an EMPTY result set. Measured on `scratch_perf_seed` on
 * 2026-09-04, before the fix: 60,025 calendar events of which exactly ONE was upcoming (the
 * private plan anchor, which is deliberately invisible to the fixture participant), and 440
 * APPROVED leave requests of which ZERO spanned today.
 *
 * A budget over an empty result set cannot fail. Its ceiling is never approached, its
 * `forbid-seq-scan` assertion has nothing to scan, and `run-read-cost-budgets.mjs` reported
 * both as vacuous — PRD-C142's "on the production-shaped seed" clause was unenforced for the
 * two dashboard reads that face the future.
 *
 * WHY THIS SPEC RATHER THAN A UNIT TEST. The defect is a property of the DATA the seed
 * produces, not of any TypeScript symbol. It is also a slow leak: the seed passed on the day
 * it ran and decayed silently afterwards, so only executing the budget's own SQL against a
 * seeded database can see it. This spec runs the exact `sql` and `params` the budget
 * declares — importing them rather than restating them, so a budget that is rewritten is
 * re-pinned automatically — and asserts the row count the budget's own `minRows` requires.
 *
 *   PERF_SEED_DB_TESTS=1 \
 *   PERF_SEED_DATABASE_URL=postgres://streamline_app@127.0.0.1:5432/scratch_perf_seed \
 *   PGSSLMODE=disable npx jest --runInBand --testPathPattern="perf-seed-forward-window"
 */
import postgres from "postgres";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ENABLED = process.env.PERF_SEED_DB_TESTS === "1";
const DB_URL = process.env.PERF_SEED_DATABASE_URL ?? process.env.APP_DATABASE_URL;
const describeDb = ENABLED && DB_URL ? describe : describe.skip;

const REFERENCE_ORG = process.env.PERF_SEED_ORG_ID ?? "aaaaaaaa-1111-0000-0000-000000000001";

interface ResolvedBudget {
  id: string;
  minRows: number | null;
  sql: string;
  params: postgres.ParameterOrJSON<never>[] | null;
}

/** The two budgets whose predicate points forward in time. */
const FORWARD_WINDOW_BUDGET_IDS = ["dashboard-personal-calendar-events", "dashboard-leaves-today"];

/**
 * `read-cost-budgets.mjs` is a native ES module and this suite runs under ts-jest's CommonJS
 * transform, which cannot require() one. Reading the budgets out of a short-lived `node`
 * process keeps the spec pinned to the DECLARED budget — its real SQL and its real `params`
 * closure — instead of restating a copy that could drift away from the gate it guards.
 */
function resolveDeclaredBudgets(fixtures: Record<string, unknown>): ResolvedBudget[] {
  const modulePath = pathToFileURL(
    resolve(__dirname, "..", "..", "src", "scripts", "read-cost-budgets.mjs"),
  ).href;
  const program = `
    import { BUDGETS } from ${JSON.stringify(modulePath)};
    const fixtures = JSON.parse(process.argv[1]);
    const wanted = JSON.parse(process.argv[2]);
    const out = wanted.map((id) => {
      const b = BUDGETS.find((x) => x.id === id);
      if (!b) return { id, minRows: null, sql: "", params: null, missing: true };
      return { id, minRows: b.minRows ?? null, sql: b.sql, params: b.params(fixtures) ?? null };
    });
    process.stdout.write(JSON.stringify(out));
  `;
  const stdout = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", program, JSON.stringify(fixtures), JSON.stringify(FORWARD_WINDOW_BUDGET_IDS)],
    { encoding: "utf8" },
  );
  return JSON.parse(stdout) as ResolvedBudget[];
}

describeDb("perf seed forward window", () => {
  const sql = postgres(DB_URL as string, {
    max: 1,
    prepare: false,
    ssl: process.env.PGSSLMODE === "disable" ? false : "require",
    onnotice: () => {},
  });

  let fixtures: Record<string, unknown>;
  let declared: ResolvedBudget[];

  /**
   * Every read here runs as the non-owner application role, so row-level security refuses a
   * statement outside a tenant context. `run-read-cost-budgets.mjs` opens each measurement the
   * same way; measuring as the owner would bypass RLS and report a plan the application never
   * gets.
   */
  const inTenant = async <T>(query: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
    sql.begin(async (tx) => {
      await tx`SELECT set_config('app.organization_id', ${REFERENCE_ORG}, true)`;
      return query(tx as postgres.TransactionSql);
    }) as Promise<T>;

  beforeAll(async () => {
    const [participant] = await inTenant((tx) => tx.unsafe(
      `SELECT ta.membership_id, om.user_id
         FROM build.ticket_assignees ta
         INNER JOIN organization_members om ON om.org_id = ta.org_id AND om.id = ta.membership_id
        WHERE ta.org_id = $1
        GROUP BY ta.membership_id, om.user_id
        ORDER BY count(*) DESC LIMIT 1`,
      [REFERENCE_ORG],
    ));
    const [calendarEvent] = await inTenant((tx) => tx.unsafe(
      `SELECT 1 FROM calendar_events WHERE org_id = $1 LIMIT 1`,
      [REFERENCE_ORG],
    ));
    fixtures = {
      orgId: REFERENCE_ORG,
      userId: participant?.user_id ?? null,
      membershipId: participant?.membership_id ?? null,
      hasCalendarEvents: Boolean(calendarEvent),
    };
    declared = resolveDeclaredBudgets(fixtures);
  }, 60_000);

  afterAll(async () => {
    await sql.end();
  });

  it("resolves the fixture participant the two budgets are parameterised by", () => {
    expect(fixtures.userId).toBeTruthy();
    expect(fixtures.membershipId).toBeTruthy();
    expect(fixtures.hasCalendarEvents).toBe(true);
  });

  for (const id of FORWARD_WINDOW_BUDGET_IDS) {
    it(`${id} measures a non-empty result set on the production-shaped seed`, async () => {
      const budget = declared.find((b) => b.id === id);
      expect(budget).toBeDefined();
      expect(budget!.params).not.toBeNull();

      const rows = await inTenant((tx) => tx.unsafe(budget!.sql, budget!.params ?? undefined));

      // `minRows` is the budget's own floor; a budget that returns fewer rows than it
      // declares is measuring something other than the read it claims to measure.
      expect(rows.length).toBeGreaterThanOrEqual(budget!.minRows ?? 1);
    }, 60_000);
  }

  /**
   * A day of lead time, deliberately. `seedReminderWindow` writes events minutes ahead of
   * `now()`, and counting those would let this pass over a window that empties within the
   * hour — which is the failure mode the whole section exists to prevent.
   */
  it("keeps a live forward window of org-visible calendar events", async () => {
    const [row] = await inTenant((tx) => tx.unsafe(
      `SELECT count(*)::int AS upcoming
         FROM calendar_events
        WHERE org_id = $1 AND visibility = 'org' AND rrule IS NULL
          AND start_date >= now() + interval '1 day'`,
      [REFERENCE_ORG],
    ));
    expect(row.upcoming).toBeGreaterThanOrEqual(60);
  }, 60_000);

  it("keeps approved leave requests spanning the current date", async () => {
    const [row] = await inTenant((tx) => tx.unsafe(
      `SELECT count(*)::int AS spanning
         FROM leave_requests
        WHERE org_id = $1 AND status = 'APPROVED'
          AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE`,
      [REFERENCE_ORG],
    ));
    expect(row.spanning).toBeGreaterThanOrEqual(12);
  }, 60_000);
});
