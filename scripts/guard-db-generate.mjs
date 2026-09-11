import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(process.cwd(), "migrations");
const META = join(MIGRATIONS, "meta");

function latestSnapshotNumber() {
  const nums = readdirSync(META)
    .filter((f) => /^\d{4}_snapshot\.json$/.test(f))
    .map((f) => Number(f.slice(0, 4)));
  return nums.length ? Math.max(...nums) : -1;
}

export function decide({ entries, snapshot, forced }) {
  const drift = entries - (snapshot + 1);
  return { drift, blocked: drift > 0 && !forced };
}

/**
 * Read this repository's REAL journal and snapshot chain.
 *
 * Anti-vacuity: an unreadable journal, an empty one, or a meta/ directory with no snapshot at
 * all each throw. Returning zeros there would make `decide` report drift 0 and the guard report
 * "not stale", which is the shape where a broken read prints a clean pass.
 */
export function readRealChain() {
  const journal = JSON.parse(readFileSync(join(META, "_journal.json"), "utf8"));
  const entries = Array.isArray(journal.entries) ? journal.entries.length : -1;
  if (entries <= 0) throw new Error(`migrations/meta/_journal.json declares ${entries} entries — the read is broken, not the repo`);
  const snapshot = latestSnapshotNumber();
  if (snapshot < 0) throw new Error("migrations/meta/ contains no NNNN_snapshot.json — the read is broken, not the repo");
  return { entries, snapshot };
}

/**
 * `--check` is the GATE half, and it exists because there was not one.
 *
 * Until 2026-09-03 the package script `check:db-generate-guard` was literally
 * `node scripts/guard-db-generate.mjs --self-test`, wired into ci.yml under the step name
 * "db:generate cannot be run against a stale snapshot" — a claim about THIS repository that the
 * command could not evaluate. The self-test asserts `decide()` against four hard-coded argument
 * pairs (entries: 634, snapshot: 464) and never opens migrations/meta at all. Its own assertion
 * key is named `reports_the_real_drift` and the number it checks is 169, while the real drift
 * measured that day was 207 (672 journal entries, latest snapshot 0464). Delete every migration
 * in the repository and that gate still exits 0.
 *
 * The script could not simply be run without the flag either: its default path SPAWNS
 * `drizzle-kit generate`, which the root brief records as unusable here. So the check had no
 * mode to run. This is that mode: it reads the real chain and asserts the guard is ARMED against
 * it, without generating anything.
 */
function runCheck() {
  let chain;
  try {
    chain = readRealChain();
  } catch (error) {
    console.error(`check:db-generate-guard: ${error.message}`);
    process.exit(1);
  }
  const { entries, snapshot } = chain;
  const unforced = decide({ entries, snapshot, forced: false });
  const forcedVerdict = decide({ entries, snapshot, forced: true });

  const failures = [];
  // The guard must reach the same verdict on the real numbers that it reaches on fixtures.
  if (unforced.drift > 0 && unforced.blocked !== true)
    failures.push(`drift is ${unforced.drift} but the guard would NOT block — db:generate is unguarded`);
  if (unforced.drift <= 0 && unforced.blocked !== false)
    failures.push(`drift is ${unforced.drift} but the guard would block — the guard is misfiring`);
  // The documented escape hatch must still exist, or the guard is unbypassable and someone will
  // delete it rather than set the variable.
  if (forcedVerdict.blocked !== false)
    failures.push("ALLOW_DB_GENERATE=1 does not release the guard — the documented escape hatch is broken");

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error("check:db-generate-guard: the guard is not armed against this repository.");
    process.exit(1);
  }

  console.log(
    `check:db-generate-guard: ${entries} journal entries, latest snapshot ` +
      `${String(snapshot).padStart(4, "0")}, real drift ${unforced.drift} — ` +
      `db:generate is ${unforced.blocked ? "BLOCKED" : "allowed"} without ALLOW_DB_GENERATE=1.`,
  );
  process.exit(0);
}

if (process.argv.includes("--check")) runCheck();

if (process.argv.includes("--self-test")) {
  const checks = {
    blocks_when_snapshot_is_stale: decide({ entries: 634, snapshot: 464, forced: false }).blocked === true,
    // Renamed 2026-09-03: this asserts the ARITHMETIC on a fixture pair. It was called
    // `reports_the_real_drift`, which is what made a detector-only run read as a repository
    // check. The real chain is read by --check, not here.
    reports_fixture_drift_arithmetic: decide({ entries: 634, snapshot: 464, forced: false }).drift === 169,
    // Anti-vacuity: the real read must actually reach the files, and must refuse to
    // manufacture a zero when it cannot.
    reads_the_real_chain: (() => {
      try {
        const { entries, snapshot } = readRealChain();
        return entries > 0 && snapshot >= 0;
      } catch {
        return false;
      }
    })(),
    allows_when_snapshot_is_current: decide({ entries: 634, snapshot: 633, forced: false }).blocked === false,
    allows_when_explicitly_forced: decide({ entries: 634, snapshot: 464, forced: true }).blocked === false,
    allows_when_snapshot_is_ahead: decide({ entries: 10, snapshot: 20, forced: false }).blocked === false,
  };
  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

const journal = JSON.parse(readFileSync(join(META, "_journal.json"), "utf8"));
const entries = journal.entries.length;
const snapshot = latestSnapshotNumber();
const forced = process.env.ALLOW_DB_GENERATE === "1";
const { drift } = decide({ entries, snapshot, forced });

if (drift > 0 && !forced) {
  console.error(
    [
      "",
      "✖ db:generate is BLOCKED: the Drizzle snapshot chain does not describe this database.",
      `  Newest snapshot: ${String(snapshot).padStart(4, "0")}_snapshot.json`,
      `  Journal entries: ${entries}`,
      `  Migrations with no snapshot: ${drift}`,
      "",
      "  Every migration since that snapshot was hand-written, so drizzle-kit's idea of the",
      "  current schema is ~" + drift + " migrations out of date. Generating now does not produce",
      "  the small diff you expect: it emits one migration that tries to recreate, drop and",
      "  rewrite objects the database already has, including the composite tenant foreign keys",
      "  that enforce cross-tenant isolation.",
      "",
      "  Write the migration by hand and add its journal entry, as every migration since",
      String(snapshot).padStart(4, "0") + " has done. To regenerate the snapshot chain deliberately,",
      "  set ALLOW_DB_GENERATE=1 and review the emitted migration before keeping it.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const result = spawnSync("drizzle-kit", ["generate", "--config", "drizzle.config.ts"], {
  stdio: "inherit",
  shell: true,
});
process.exit(result.status ?? 1);
