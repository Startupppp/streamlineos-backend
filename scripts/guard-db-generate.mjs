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

if (process.argv.includes("--self-test")) {
  const checks = {
    blocks_when_snapshot_is_stale: decide({ entries: 634, snapshot: 464, forced: false }).blocked === true,
    reports_the_real_drift: decide({ entries: 634, snapshot: 464, forced: false }).drift === 169,
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
