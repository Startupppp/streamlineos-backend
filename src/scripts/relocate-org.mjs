import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const RELOCATION_STATES = [
  "ACTIVE_SOURCE",
  "SNAPSHOT",
  "CATCH_UP",
  "READ_ONLY_SOURCE",
  "VERIFY_TARGET",
  "FLIP_PLACEMENT",
  "ACTIVE_TARGET",
  "RETIRE_SOURCE",
  "ROLLED_BACK",
  "FAILED",
];

const TRANSITIONS = {
  ACTIVE_SOURCE: ["SNAPSHOT", "ROLLED_BACK", "FAILED"],
  SNAPSHOT: ["CATCH_UP", "ROLLED_BACK", "FAILED"],
  CATCH_UP: ["READ_ONLY_SOURCE", "ROLLED_BACK", "FAILED"],
  READ_ONLY_SOURCE: ["VERIFY_TARGET", "ROLLED_BACK", "FAILED"],
  VERIFY_TARGET: ["FLIP_PLACEMENT", "ROLLED_BACK", "FAILED"],
  FLIP_PLACEMENT: ["ACTIVE_TARGET", "FAILED"],
  ACTIVE_TARGET: ["RETIRE_SOURCE", "FAILED"],
  RETIRE_SOURCE: [],
  ROLLED_BACK: [],
  FAILED: [],
};

const TERMINAL_STATES = new Set(["ROLLED_BACK", "FAILED"]);

const FORWARD_SEQUENCE = [
  "ACTIVE_SOURCE",
  "SNAPSHOT",
  "CATCH_UP",
  "READ_ONLY_SOURCE",
  "VERIFY_TARGET",
  "FLIP_PLACEMENT",
  "ACTIVE_TARGET",
  "RETIRE_SOURCE",
];

function canRollback(state) {
  const idx = FORWARD_SEQUENCE.indexOf(state);
  return idx >= 0 && idx <= 4;
}

function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

function isTransitionAllowed(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

function nextForwardState(current) {
  const idx = FORWARD_SEQUENCE.indexOf(current);
  if (idx < 0 || idx >= FORWARD_SEQUENCE.length - 1) return null;
  return FORWARD_SEQUENCE[idx + 1];
}

const PRODUCTION_HOST_PATTERNS = ["amazonaws.com", "neon.tech", "neon-db.net", "supabase.co", ".render.com"];

export function assertRelocationTarget(url, allowProduction) {
  if (!url) return { allowed: false, reason: "DATABASE_URL is not set" };
  const matched = PRODUCTION_HOST_PATTERNS.find((p) => url.includes(p));
  if (!matched) return { allowed: true, reason: "not a known production host" };
  if (allowProduction === "1") return { allowed: true, reason: `production host '${matched}' — ALLOW_PRODUCTION_MIGRATION=1 acknowledged` };
  return { allowed: false, reason: `DATABASE_URL names production host '${matched}'; set ALLOW_PRODUCTION_MIGRATION=1 to proceed deliberately` };
}

function loadDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required (set it explicitly; no .env fallback).");
    process.exit(1);
  }
  return url;
}

async function getRelocation(db, orgId) {
  const rows = await db`
    SELECT relocation_id, organization_id, source_cell, target_cell,
           current_state, placement_version_at_start, failure_reason,
           rollback_reason, is_active, started_at, updated_at
    FROM organization_relocations
    WHERE organization_id = ${orgId} AND is_active = true
    LIMIT 1`;
  return rows[0] ?? null;
}

async function advanceState(db, orgId) {
  const relocation = await getRelocation(db, orgId);
  if (!relocation) {
    console.error(`No active relocation found for org ${orgId}.`);
    process.exit(1);
  }

  const current = relocation.current_state;
  if (isTerminal(current)) {
    console.error(`Relocation is in terminal state "${current}". No further transitions.`);
    process.exit(1);
  }

  const next = nextForwardState(current);
  if (!next) {
    console.error(`No forward transition from "${current}". The relocation may be complete.`);
    process.exit(1);
  }

  if (!isTransitionAllowed(current, next)) {
    console.error(`Transition from "${current}" to "${next}" is not allowed.`);
    process.exit(1);
  }

  const isNextTerminal = next === "RETIRE_SOURCE";
  await db`
    UPDATE organization_relocations
    SET current_state = ${next},
        is_active = ${!isNextTerminal},
        updated_at = NOW()
    WHERE organization_id = ${orgId} AND is_active = true
      AND current_state = ${current}`;

  console.log(`Relocation for org ${orgId}: ${current} → ${next}`);
}

async function rollbackRelocation(db, orgId, reason) {
  const relocation = await getRelocation(db, orgId);
  if (!relocation) {
    console.error(`No active relocation found for org ${orgId}.`);
    process.exit(1);
  }

  const current = relocation.current_state;
  if (!canRollback(current)) {
    console.error(
      `Rollback is not available from state "${current}". ` +
        `Once FLIP_PLACEMENT completes, reverting requires a fresh relocation in the opposite direction.`,
    );
    process.exit(1);
  }

  await db`
    UPDATE organization_relocations
    SET current_state = 'ROLLED_BACK',
        is_active = false,
        rollback_reason = ${reason ?? "operator-initiated"},
        updated_at = NOW()
    WHERE organization_id = ${orgId} AND is_active = true
      AND current_state = ${current}`;

  console.log(`Relocation for org ${orgId} rolled back from ${current} → ROLLED_BACK.`);
}

async function showStatus(db, orgId) {
  const relocation = await getRelocation(db, orgId);
  if (!relocation) {
    console.log(`No active relocation for org ${orgId}.`);
    return;
  }
  console.log(`Org:           ${relocation.organization_id}`);
  console.log(`Relocation ID: ${relocation.relocation_id}`);
  console.log(`State:         ${relocation.current_state}`);
  console.log(`Source cell:   ${relocation.source_cell}`);
  console.log(`Target cell:   ${relocation.target_cell}`);
  console.log(`Started:       ${relocation.started_at}`);
  console.log(`Updated:       ${relocation.updated_at}`);
  if (relocation.failure_reason)
    console.log(`Failure:       ${relocation.failure_reason}`);
  if (relocation.rollback_reason)
    console.log(`Rollback:      ${relocation.rollback_reason}`);
}

function runSelfTest() {
  const failures = [];

  const illegalResult = isTransitionAllowed("ACTIVE_SOURCE", "RETIRE_SOURCE");
  if (illegalResult)
    failures.push("FAIL: illegal transition ACTIVE_SOURCE→RETIRE_SOURCE was permitted");

  const postFlipRollback = canRollback("FLIP_PLACEMENT");
  if (postFlipRollback)
    failures.push("FAIL: post-flip rollback from FLIP_PLACEMENT was permitted");

  const postActiveTargetRollback = canRollback("ACTIVE_TARGET");
  if (postActiveTargetRollback)
    failures.push("FAIL: post-flip rollback from ACTIVE_TARGET was permitted");

  const validTransition = isTransitionAllowed("ACTIVE_SOURCE", "SNAPSHOT");
  if (!validTransition)
    failures.push("FAIL: valid transition ACTIVE_SOURCE→SNAPSHOT was rejected");

  const preFlipRollback = canRollback("VERIFY_TARGET");
  if (!preFlipRollback)
    failures.push("FAIL: pre-flip rollback from VERIFY_TARGET was rejected");

  const guardCases = [
    [assertRelocationTarget("postgresql://u:p@127.0.0.1:5432/app", undefined), true],
    [assertRelocationTarget("postgresql://u:p@prod.cluster.amazonaws.com/app", undefined), false],
    [assertRelocationTarget("postgresql://u:p@prod.cluster.amazonaws.com/app", "1"), true],
    [assertRelocationTarget("postgresql://u:p@db.neon.tech/neondb", undefined), false],
    [assertRelocationTarget(undefined, undefined), false],
  ];
  for (const [verdict, expected] of guardCases) {
    if (verdict.allowed !== expected)
      failures.push(`FAIL: target guard: expected allowed=${expected}, got '${verdict.reason}'`);
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(f);
    console.error("\nSELF-TEST FAIL: guards are not biting.");
    process.exit(1);
  }

  console.log("SELF-TEST PASS: illegal transition rejected, post-flip rollback rejected, target guard correct.");
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const orgArg = args.find((a) => a.startsWith("--org="));
  const toArg = args.find((a) => a.startsWith("--to="));
  const reasonArg = args.find((a) => a.startsWith("--reason="));
  const advance = args.includes("--advance");
  const rollback = args.includes("--rollback");
  const status = args.includes("--status");

  if (!orgArg) {
    console.error(`
Operator runner for organization cell relocations.

  node src/scripts/relocate-org.mjs --org=<id> --status
  node src/scripts/relocate-org.mjs --org=<id> --to=<cell> --advance
  node src/scripts/relocate-org.mjs --org=<id> --rollback [--reason=<text>]
  node src/scripts/relocate-org.mjs --self-test

  --status    Show the current relocation state.
  --advance   Advance one step in the forward direction.
  --rollback  Roll back to ROLLED_BACK. Only allowed before FLIP_PLACEMENT completes.
  --self-test Prove the transition guard and rollback guard bite. No DB required.
`);
    process.exit(1);
  }

  const orgId = orgArg.slice("--org=".length);

  const url = loadDatabaseUrl();
  const _relocGuard = assertRelocationTarget(url, process.env.ALLOW_PRODUCTION_MIGRATION);
  if (!_relocGuard.allowed) {
    console.error(`relocate-org BLOCKED — ${_relocGuard.reason}`);
    process.exit(2);
  }
  const db = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

  try {
    if (status) {
      await showStatus(db, orgId);
    } else if (advance) {
      if (!toArg && !(await getRelocation(db, orgId))) {
        console.error("--to=<cell> is required to start a new relocation.");
        process.exit(1);
      }
      await advanceState(db, orgId);
    } else if (rollback) {
      const reason = reasonArg ? reasonArg.slice("--reason=".length) : undefined;
      await rollbackRelocation(db, orgId, reason);
    } else {
      console.error("Specify --status, --advance, or --rollback.");
      process.exit(1);
    }
  } finally {
    await db.end();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error("RUNNER FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
