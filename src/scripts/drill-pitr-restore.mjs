import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const NEON_API = "https://console.neon.tech/api/v2";
const argv = process.argv.slice(2);
const selfTest = argv.includes("--self-test");

function loadVar(name) {
  if (process.env[name]) return process.env[name];
  const p = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, "utf8").match(new RegExp(`^${name}\\s*=\\s*(.+)$`, "m"));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : null;
}

function checkWatermark(branchCount, mainCount) {
  if (branchCount !== mainCount)
    return { pass: false, detail: `migration count mismatch: branch=${branchCount} main=${mainCount}` };
  return { pass: true, detail: `${mainCount} migration(s) on both branch and main` };
}

function checkBeforeMarker(found) {
  if (!found)
    return { pass: false, detail: "before-marker row not found on branch — branch may be too far back" };
  return { pass: true, detail: `before-marker found on branch (migration_id=${found})` };
}

function checkAfterMarkerAbsent(found) {
  if (found !== null)
    return { pass: false, detail: `after-marker row present on branch (id=${found}) — PITR cut was not applied at the target timestamp` };
  return { pass: true, detail: "after-marker absent from branch — PITR cut confirmed" };
}

function checkPolicies(branchCount, mainCount) {
  if (branchCount === 0)
    return { pass: false, detail: "zero RLS policies on branch — tenant isolation was lost in restore" };
  if (branchCount < mainCount)
    return { pass: false, detail: `branch has ${branchCount} policies, main has ${mainCount} — ${mainCount - branchCount} policy/policies missing from restore` };
  return { pass: true, detail: `${branchCount} RLS policies on branch (main=${mainCount})` };
}

function runSelfTest() {
  const out = (s) => process.stdout.write(s + "\n");

  out("self-test: fixture verification for drill-pitr-restore\n");

  const fixtures = [
    { label: "watermark-mismatch",       fn: () => checkWatermark(5, 6),          expectFail: true },
    { label: "before-marker-absent",     fn: () => checkBeforeMarker(null),        expectFail: true },
    { label: "after-marker-present",     fn: () => checkAfterMarkerAbsent("x99"),  expectFail: true },
    { label: "policy-count-zero",        fn: () => checkPolicies(0, 42),           expectFail: true },
    { label: "policy-count-reduced",     fn: () => checkPolicies(10, 42),          expectFail: true },
    { label: "watermark-match",          fn: () => checkWatermark(42, 42),         expectFail: false },
    { label: "before-marker-present",    fn: () => checkBeforeMarker("mig-001"),   expectFail: false },
    { label: "after-marker-absent",      fn: () => checkAfterMarkerAbsent(null),   expectFail: false },
    { label: "policy-count-ok",          fn: () => checkPolicies(42, 42),          expectFail: false },
  ];

  let errors = 0;
  for (const { label, fn, expectFail } of fixtures) {
    const r = fn();
    const gotFail = !r.pass;
    if (gotFail !== expectFail) {
      process.stderr.write(`  FAIL  ${label}: expected ${expectFail ? "FAIL" : "PASS"} but got ${gotFail ? "FAIL" : "PASS"} — ${r.detail}\n`);
      errors++;
    } else {
      out(`  PASS  ${label}: correctly ${gotFail ? "detected failure" : "passed"} — ${r.detail}`);
    }
  }

  if (errors > 0) {
    process.stderr.write(`\nself-test: ${errors} fixture(s) wrong — verification logic is broken\n`);
    process.exit(1);
  }
  out("\nself-test PASS — all verification fixtures behave correctly");
  process.exit(0);
}

if (selfTest) runSelfTest();

const NEON_API_KEY = loadVar("NEON_API_KEY");
const NEON_PROJECT_ID = loadVar("NEON_PROJECT_ID");
const DATABASE_URL = loadVar("DATABASE_URL");
const APP_DATABASE_URL = loadVar("APP_DATABASE_URL");

const RUNBOOK = `
PITR RESTORE DRILL — PREREQUISITES MISSING

  NEON_API_KEY      — Neon console → Account Settings → API Keys
  NEON_PROJECT_ID   — Neon console → project settings URL
  DATABASE_URL      — owner-role connection string (neondb_owner or equivalent)
  APP_DATABASE_URL  — app-role connection string (streamline_app role, optional but recommended)

  Set these in .env (backend/) and re-run:
    node --env-file-if-exists=.env src/scripts/drill-pitr-restore.mjs

  What this drill does:
    1. Reads the migration watermark from the source branch (owner role).
    2. Writes a synthetic after-marker row to audit_logs.
    3. Creates a Neon branch at the target timestamp (just before the after-marker write).
    4. Connects to the branch and verifies:
         a. Migration watermark matches.
         b. A known pre-target row is present.
         c. The after-marker row is absent.
         d. RLS policy count is non-zero and matches the source.
         e. The app role can connect (with tenant GUC).
    5. Deletes the branch and the after-marker row.
`;

const missing = [];
if (!NEON_API_KEY) missing.push("NEON_API_KEY");
if (!NEON_PROJECT_ID) missing.push("NEON_PROJECT_ID");
if (!DATABASE_URL) missing.push("DATABASE_URL");

if (missing.length > 0) {
  process.stderr.write(`DRILL BLOCKED — missing env var(s): ${missing.join(", ")}\n${RUNBOOK}\n`);
  process.exit(1);
}

async function neonFetch(method, path2, body) {
  const res = await fetch(`${NEON_API}${path2}`, {
    method,
    headers: {
      Authorization: `Bearer ${NEON_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Neon API ${method} ${path2} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function substituteBranchHost(connUrl, branchHost) {
  const parsed = new URL(connUrl);
  parsed.hostname = branchHost;
  return parsed.toString();
}

function connect(url) {
  return postgres(url, { max: 1, prepare: false, onnotice: () => {} });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const out = (s) => process.stdout.write(`[${new Date().toISOString()}] ${s}\n`);

async function main() {
  out("=== PITR RESTORE DRILL ===");

  const ownerSql = connect(DATABASE_URL);
  let branchId = null;
  let afterMarkerId = null;

  try {
    out("Step 1 — reading source branch state (migration watermark, policy count)");

    const [wm] = await ownerSql`SELECT count(*)::int AS cnt FROM drizzle.__drizzle_migrations`;
    const mainWatermark = Number(wm?.cnt ?? 0);
    out(`  migration watermark: ${mainWatermark} migration(s) applied`);

    if (mainWatermark === 0) {
      process.stderr.write("DRILL BLOCKED — drizzle.__drizzle_migrations has 0 rows; source branch has no migrations applied\n");
      await ownerSql.end();
      process.exit(1);
    }

    const [latestMig] = await ownerSql`
      SELECT id FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`;
    const beforeMarkerId = latestMig?.id ?? null;
    out(`  before-marker migration id: ${beforeMarkerId}`);

    const [policyCnt] = await ownerSql`
      SELECT count(*)::int AS cnt FROM pg_policy`;
    const mainPolicies = Number(policyCnt?.cnt ?? 0);
    out(`  source branch RLS policies: ${mainPolicies}`);

    out("\nStep 2 — writing after-marker row to audit_logs");

    const targetTs = new Date();

    await sleep(1500);

    const [member] = await ownerSql`
      SELECT user_id, org_id FROM organization_members LIMIT 1`;

    if (!member) {
      out("  WARNING: no organization members found — skipping after-marker write; row-level PITR check will be PARTIAL");
    } else {
      const markerAction = `pitr.drill.after-marker.${Date.now()}`;
      try {
        const [inserted] = await ownerSql`
          INSERT INTO audit_logs (action, user_id, org_id, is_platform_event)
          VALUES (${markerAction}, ${member.user_id}, ${member.org_id}, false)
          RETURNING id`;
        afterMarkerId = inserted?.id ?? null;
        out(`  after-marker written: audit_logs.id=${afterMarkerId} action="${markerAction}"`);
      } catch (e) {
        out(`  WARNING: after-marker insert failed (${e.message}) — row-level check will be PARTIAL`);
      }
    }

    out("\nStep 3 — listing Neon branches to find the default branch");
    const { branches } = await neonFetch("GET", `/projects/${encodeURIComponent(NEON_PROJECT_ID)}/branches`);
    const defaultBranch = (branches ?? []).find((b) => b.default || b.name === "main");
    if (!defaultBranch) {
      process.stderr.write("DRILL FAILED — cannot identify default branch from Neon API response\n");
      process.exit(1);
    }
    out(`  default branch: id=${defaultBranch.id} name=${defaultBranch.name}`);

    const restoreTs = new Date(targetTs.getTime() + 500).toISOString();
    out(`\nStep 4 — creating Neon branch at target timestamp: ${restoreTs}`);
    const createResp = await neonFetch("POST", `/projects/${encodeURIComponent(NEON_PROJECT_ID)}/branches`, {
      branch: {
        parent_id: defaultBranch.id,
        parent_timestamp: restoreTs,
      },
      endpoints: [{ type: "read_write" }],
    });

    branchId = createResp.branch?.id;
    const branchEndpoint = (createResp.endpoints ?? [])[0];
    const branchHost = branchEndpoint?.host;

    if (!branchId || !branchHost) {
      process.stderr.write(`DRILL FAILED — branch creation response missing id or endpoint host: ${JSON.stringify(createResp).slice(0, 400)}\n`);
      process.exit(1);
    }
    out(`  branch created: id=${branchId} endpoint=${branchHost}`);

    out("  waiting 12s for endpoint to become active...");
    await sleep(12000);

    out("\nStep 5 — connecting to branch and verifying");
    const branchOwnerUrl = substituteBranchHost(DATABASE_URL, branchHost);
    const branchSql = connect(branchOwnerUrl);

    let passed = 0;
    let failed = 0;
    const report = (r) => {
      if (r.pass) { passed++; out(`  PASS  ${r.detail}`); }
      else { failed++; process.stderr.write(`  FAIL  ${r.detail}\n`); }
    };

    const [branchWm] = await branchSql`SELECT count(*)::int AS cnt FROM drizzle.__drizzle_migrations`;
    report(checkWatermark(Number(branchWm?.cnt ?? 0), mainWatermark));

    const [branchBefore] = await branchSql`
      SELECT id FROM drizzle.__drizzle_migrations WHERE id = ${beforeMarkerId} LIMIT 1`;
    report(checkBeforeMarker(branchBefore?.id ?? null));

    if (afterMarkerId !== null) {
      const [branchAfter] = await branchSql`
        SELECT id FROM audit_logs WHERE id = ${afterMarkerId} LIMIT 1`;
      report(checkAfterMarkerAbsent(branchAfter?.id ?? null));
    } else {
      out("  SKIP  after-marker check (marker was not written — row-level PITR proof is PARTIAL)");
    }

    const [branchPol] = await branchSql`SELECT count(*)::int AS cnt FROM pg_policy`;
    report(checkPolicies(Number(branchPol?.cnt ?? 0), mainPolicies));

    await branchSql.end();

    if (APP_DATABASE_URL) {
      out("\nStep 6 — verifying app role can connect to branch");
      const branchAppUrl = substituteBranchHost(APP_DATABASE_URL, branchHost);
      const branchAppSql = connect(branchAppUrl);
      try {
        const [omCount] = await branchAppSql.begin(async (tx) => {
          await tx`SELECT set_config('app.organization_id', '', true)`;
          return tx`SELECT 1 AS ok`;
        });
        if (omCount?.ok === 1) {
          passed++;
          out("  PASS  app role connected to branch successfully");
        } else {
          failed++;
          process.stderr.write("  FAIL  app role connected but query returned unexpected result\n");
        }
      } catch (e) {
        failed++;
        process.stderr.write(`  FAIL  app role could not connect to branch: ${e.message}\n`);
      }
      await branchAppSql.end();
    } else {
      out("  SKIP  app role connection check (APP_DATABASE_URL not set)");
    }

    out(`\n=== RESULT: ${failed === 0 ? "PASS" : "FAIL"} (${passed} passed, ${failed} failed) ===`);

    if (failed > 0) {
      process.stderr.write("\n  Action required: investigate FAILed checks above before declaring PITR fit for production.\n");
    }

  } finally {
    if (branchId) {
      out(`\nCleanup — deleting branch ${branchId}`);
      try {
        await neonFetch("DELETE", `/projects/${encodeURIComponent(NEON_PROJECT_ID)}/branches/${encodeURIComponent(branchId)}`);
        out("  branch deleted");
      } catch (e) {
        process.stderr.write(`  WARNING: branch deletion failed: ${e.message}\n  Manual cleanup: Neon console → project → Branches → delete ${branchId}\n`);
      }
    }
    if (afterMarkerId !== null) {
      try {
        await ownerSql`DELETE FROM audit_logs WHERE id = ${afterMarkerId}`;
        out(`  after-marker row ${afterMarkerId} deleted from source branch`);
      } catch (e) {
        process.stderr.write(`  WARNING: could not delete after-marker row id=${afterMarkerId}: ${e.message}\n`);
      }
    }
    await ownerSql.end();
  }

  process.exit(0);
}

main().catch(async (err) => {
  process.stderr.write(`\nDrill crashed: ${err.message}\n${err.stack ?? ""}\n`);
  process.exit(1);
});
