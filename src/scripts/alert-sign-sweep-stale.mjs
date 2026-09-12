import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

/**
 * `quiet` because stdout is the alert payload. dotenv prints a banner there
 * by default, which makes `pnpm alert:… | jq` fail on the first character —
 * so the rows naming the affected organisations could not be read by the
 * oncall integration these scripts exist to feed.
 */
dotenv.config({ path: resolve(process.cwd(), ".env"), quiet: true });

/**
 * SIGN-P1-02. Fires when a SignOS sweep has not run inside its expected window.
 *
 * The failure this exists to catch is the one SignOS was actually in: the
 * reminder and expiration sweeps were complete, correct, and wired to no
 * scheduler at all. Nothing was broken, so nothing looked broken — every
 * envelope's "we will remind them in three days" was a promise no process kept,
 * and the only evidence was an absence.
 *
 * Which is why this is a LEFT JOIN from the organisations that should be swept,
 * not a scan of `sign_sweep_runs`. `WHERE ran_at < NOW() - interval` returns no
 * rows for an organisation that has never run once — the very worst state reads
 * as healthy. An organisation with no row is the loudest case here, reported as
 * `never_run`.
 *
 * Three conditions fire, all of them "this sweep is not doing its job":
 *   never_run  no row at all, for an org old enough to have been swept
 *   stale      the last run is older than the window
 *   errored    the last run recorded a failure, however recently
 *
 * Organisations younger than the window are excluded: they have not had a
 * chance to be swept yet, and alerting on them would train the reader to
 * ignore this.
 *
 *   pnpm alert:sign-sweep-stale [--hours=26]
 *   pnpm alert:sign-sweep-stale:self-test
 *
 * Exit 1 fires, 0 clear, 2 prerequisite unmet.
 */

const args = process.argv.slice(2);

/**
 * 26 rather than 24. Both sweeps are meant to run daily; a window equal to the
 * period alerts on ordinary scheduling jitter, and an alert that cries wolf is
 * an alert nobody reads.
 */
const hours = Math.max(1, parseInt(args.find((a) => a.startsWith("--hours="))?.slice(8) ?? "26", 10));
const THRESHOLD = 0;

const SWEEPS = ["reminder", "expiration"];

function predicate(rows) {
  return rows.length > THRESHOLD;
}

/** Shared by the self-test and the real query, so the two cannot disagree. */
function classify(row, nowMs, windowMs) {
  if (row.ran_at === null) return "never_run";
  if (row.error !== null) return "errored";
  if (nowMs - new Date(row.ran_at).getTime() > windowMs) return "stale";
  return null;
}

if (args.includes("--self-test")) {
  const now = Date.now();
  const windowMs = hours * 3_600_000;
  const fresh = { org_id: "org_fixture_1", sweep: "reminder", ran_at: new Date(now - 60_000).toISOString(), error: null };
  const stale = { org_id: "org_fixture_2", sweep: "reminder", ran_at: new Date(now - (hours + 1) * 3_600_000).toISOString(), error: null };
  const never = { org_id: "org_fixture_3", sweep: "expiration", ran_at: null, error: null };
  const errored = { org_id: "org_fixture_4", sweep: "reminder", ran_at: new Date(now - 60_000).toISOString(), error: "no tenant context" };

  const fire = (rows) => predicate(rows.filter((r) => classify(r, now, windowMs) !== null));

  const cases = {
    clearsOnFreshRun: fire([fresh]) === false,
    firesOnStaleRun: fire([stale]) === true,
    /** The case a `WHERE ran_at < …` query silently misses. */
    firesOnNeverRun: fire([never]) === true,
    firesOnRecentFailure: fire([errored]) === true,
    clearsOnAllFresh: fire([fresh, { ...fresh, org_id: "org_fixture_5", sweep: "expiration" }]) === false,
  };
  const pass = Object.values(cases).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, ...cases }) + "\n");
  process.exit(pass ? 0 : 1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL is required (owner/migration role — BYPASSRLS, no tenant GUC needed)\n");
  process.exit(2);
}

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
try {
  /**
   * Every (organisation, sweep) pair that ought to have run, with its last run
   * beside it or NULL if there has never been one. `runSweepAllOrgs` walks
   * every organisation rather than only the sign-enabled ones, so this does
   * too — an org that stopped being swept is the thing being looked for, and
   * narrowing by `org_modules` would hide it the moment the module row went.
   */
  const rows = await sql`
    SELECT
      o.id                AS org_id,
      s.sweep             AS sweep,
      r.ran_at            AS ran_at,
      r.error             AS error,
      r.affected          AS affected
    FROM organizations o
    CROSS JOIN (SELECT unnest(${SWEEPS}::text[]) AS sweep) s
    LEFT JOIN sign_sweep_runs r
      ON r.org_id = o.id AND r.sweep = s.sweep
    WHERE o.deleted_at IS NULL
      AND o.created_at < NOW() - (${hours} * INTERVAL '1 hour')
    ORDER BY o.id, s.sweep
  `;

  const now = Date.now();
  const windowMs = hours * 3_600_000;
  /**
   * Counted in full, listed in part. Capping before counting would report "50
   * organisations unswept" during an outage that had stopped all two thousand
   * — and the size of the number is most of the signal.
   */
  const offending = rows
    .map((row) => ({ ...row, reason: classify(row, now, windowMs) }))
    .filter((row) => row.reason !== null);
  const listed = offending.slice(0, 50);

  const fired = predicate(offending);
  process.stdout.write(
    JSON.stringify({
      fired,
      count: offending.length,
      checked: rows.length,
      byReason: {
        never_run: offending.filter((r) => r.reason === "never_run").length,
        stale: offending.filter((r) => r.reason === "stale").length,
        errored: offending.filter((r) => r.reason === "errored").length,
      },
      threshold: { maxOffendingPairs: THRESHOLD, windowHours: hours },
      destination: "CONFIGURE_ME — wire exit-code 1 to your oncall system (PagerDuty, Slack webhook, etc.)",
      truncated: offending.length > listed.length,
      rows: listed,
    }) + "\n",
  );
  process.exit(fired ? 1 : 0);
} finally {
  await sql.end();
}
