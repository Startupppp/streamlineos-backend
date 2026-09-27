import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const MIGRATIONS = join(ROOT, "migrations");
const REGISTRY_PATH = join(MIGRATIONS, "meta/_data-loss-snapshots.json");

const DATA_LOSS_RE = /@data-loss/;

const VALID_STATUSES = new Set(["snapshot_taken", "no_snapshot", "not_needed", "undetermined"]);

function validateEntry(tag, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    return `${tag}: registry entry is not an object`;
  const { status } = entry;
  if (!VALID_STATUSES.has(status))
    return `${tag}: status "${status}" is not one of ${[...VALID_STATUSES].join(", ")}`;
  if (status === "snapshot_taken") {
    if (!entry.snapshot_name || typeof entry.snapshot_name !== "string" || !entry.snapshot_name.trim())
      return `${tag}: status is "snapshot_taken" but snapshot_name is missing or empty`;
    if (!entry.snapshot_taken_at || typeof entry.snapshot_taken_at !== "string" || !entry.snapshot_taken_at.trim())
      return `${tag}: status is "snapshot_taken" but snapshot_taken_at is missing or empty`;
  }
  if (status === "no_snapshot") {
    if (!entry.reason || typeof entry.reason !== "string" || !entry.reason.trim())
      return `${tag}: status is "no_snapshot" but reason is missing or empty`;
    if (!entry.nearest_restore_point || typeof entry.nearest_restore_point !== "string" || !entry.nearest_restore_point.trim())
      return `${tag}: status is "no_snapshot" but nearest_restore_point is missing or empty`;
    if (!entry.nearest_restore_point_at || typeof entry.nearest_restore_point_at !== "string" || !entry.nearest_restore_point_at.trim())
      return `${tag}: status is "no_snapshot" but nearest_restore_point_at is missing or empty`;
  }
  if (status === "not_needed") {
    if (!entry.justification || typeof entry.justification !== "string" || !entry.justification.trim())
      return `${tag}: status is "not_needed" but justification is missing or empty`;
  }
  if (status === "undetermined") {
    if (!entry.note || typeof entry.note !== "string" || !entry.note.trim())
      return `${tag}: status is "undetermined" but note is missing or empty`;
  }
  return null;
}

function runGateLogic(sqlFiles, registry) {
  const dataLossTags = sqlFiles
    .filter((f) => DATA_LOSS_RE.test(f.sql))
    .map((f) => f.name.replace(/\.sql$/, ""));

  const fileTagSet = new Set(sqlFiles.map((f) => f.name.replace(/\.sql$/, "")));
  const failures = [];

  for (const tag of dataLossTags) {
    if (!(tag in registry)) {
      failures.push(
        `${tag}: no registry entry — add an entry to migrations/meta/_data-loss-snapshots.json before this migration can be considered covered`,
      );
      continue;
    }
    const err = validateEntry(tag, registry[tag]);
    if (err) failures.push(err);
  }

  for (const tag of Object.keys(registry)) {
    if (!fileTagSet.has(tag)) {
      failures.push(
        `registry entry "${tag}" has no corresponding migration file — remove the stale entry or restore the file`,
      );
    }
  }

  return { dataLossTags, failures };
}

function selfTest() {
  const validNoSnapshot = {
    status: "no_snapshot",
    reason: "the window closed",
    nearest_restore_point: "backup-20260101",
    nearest_restore_point_at: "2026-01-01T00:00:00Z",
  };

  const fixtures = [
    { name: "9001_test_alpha.sql", sql: "-- @data-loss\nDROP TABLE foo;" },
    { name: "9002_test_beta.sql", sql: "-- @data-loss\nDROP TABLE bar;" },
    { name: "9003_test_gamma.sql", sql: "-- normal migration\nALTER TABLE baz ADD COLUMN x text;" },
  ];

  const registryComplete = {
    "9001_test_alpha": validNoSnapshot,
    "9002_test_beta": validNoSnapshot,
  };

  const registryMissingBeta = {
    "9001_test_alpha": validNoSnapshot,
  };

  const registryStaleExtra = {
    "9001_test_alpha": validNoSnapshot,
    "9002_test_beta": validNoSnapshot,
    "9999_nonexistent": validNoSnapshot,
  };

  const registryHollow = {
    "9001_test_alpha": { status: "snapshot_taken", snapshot_taken_at: "2026-01-01T00:00:00Z" },
    "9002_test_beta": validNoSnapshot,
  };

  const registryEmptyStatus = {
    "9001_test_alpha": { status: "no_snapshot" },
    "9002_test_beta": validNoSnapshot,
  };

  const r1 = runGateLogic(fixtures, registryComplete);
  const r2 = runGateLogic(fixtures, registryMissingBeta);
  const r3 = runGateLogic(fixtures, registryStaleExtra);
  const r4 = runGateLogic(fixtures, registryHollow);
  const r5 = runGateLogic(fixtures, registryEmptyStatus);

  const tests = [
    ["complete registry passes with zero failures", r1.failures.length === 0],
    ["complete registry reports 2 @data-loss tags", r1.dataLossTags.length === 2],
    ["missing beta fails naming beta", r2.failures.some((f) => f.includes("9002_test_beta"))],
    ["missing beta does not fail alpha (paired positive)", !r2.failures.some((f) => f.includes("9001_test_alpha"))],
    ["stale registry entry fails naming the stale tag", r3.failures.some((f) => f.includes("9999_nonexistent"))],
    ["stale entry does not fail valid peers (paired positive)", r3.failures.filter((f) => f.includes("9001_test_alpha") || f.includes("9002_test_beta")).length === 0],
    ["hollow entry (missing snapshot_name) fails naming alpha", r4.failures.some((f) => f.includes("9001_test_alpha"))],
    ["hollow entry does not fail valid peer (paired positive)", !r4.failures.some((f) => f.includes("9002_test_beta"))],
    ["no_snapshot with missing required fields fails", r5.failures.some((f) => f.includes("9001_test_alpha"))],
    ["non-data-loss migration is never required", !r1.failures.some((f) => f.includes("9003_test_gamma"))],
  ];

  let failed = 0;
  for (const [name, pass] of tests) {
    console.log(`  [${pass ? "pass" : "FAIL"}] ${name}`);
    if (!pass) failed++;
  }
  console.log(failed === 0 ? "\nSELF-TEST PASSED" : `\nSELF-TEST FAILED (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv.includes("--self-test")) selfTest();

const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));

const sqlFiles = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => ({ name: f, sql: readFileSync(join(MIGRATIONS, f), "utf8") }));

const MIN_DATA_LOSS = 1;

const { dataLossTags, failures } = runGateLogic(sqlFiles, registry);

console.log(
  `check:data-loss-snapshot: ${sqlFiles.length} migration file(s), ${dataLossTags.length} with @data-loss, ${Object.keys(registry).length} registry entries`,
);

if (dataLossTags.length < MIN_DATA_LOSS) {
  console.error(
    `\nINCONCLUSIVE — @data-loss scanner matched ${dataLossTags.length} migration(s) (floor ${MIN_DATA_LOSS}); history contains @data-loss migrations so zero means the scanner stopped matching`,
  );
  process.exit(2);
}

if (failures.length > 0) {
  console.error(`\nFAIL — ${failures.length} issue(s):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log(`  OK — all ${dataLossTags.length} @data-loss migration(s) covered`);
process.exit(0);
