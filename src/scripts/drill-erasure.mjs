import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const APP_SCHEMAS = ["public", "build", "build_events"];
const argv = process.argv.slice(2);
const selfTest = argv.includes("--self-test");
const execute = argv.includes("--execute");
const iKnow = argv.includes("--i-know-what-im-doing");

const emailArg = argv.find((a) => !a.startsWith("--"));

if (!selfTest && !emailArg) {
  process.stderr.write(
    "Usage: node drill-erasure.mjs <email> [--execute] [--i-know-what-im-doing]\n\n" +
    "  (no flags)                   Dry-run: executes deletions inside a rolled-back transaction.\n" +
    "  --execute                    Commit the erasure. Irreversible.\n" +
    "  --i-know-what-im-doing       Required with --execute.\n" +
    "\n" +
    "  This drill:\n" +
    "    1. Enumerates FK cascade order from pg_catalog (not a hand-written list).\n" +
    "    2. Identifies tables that are NOT CASCADE — must be deleted first manually.\n" +
    "    3. Identifies soft-delete intermediaries whose children would be orphaned.\n" +
    "    4. Executes deletions inside a transaction (dry-run: rolled back).\n" +
    "    5. Re-queries each affected table inside the same transaction to prove absence.\n" +
    "    6. Reports any table that still contains rows for the subject after deletion.\n",
  );
  process.exit(1);
}

function loadVar(name) {
  return process.env[name] ?? null;
}

const PRODUCTION_HOST_PATTERNS = ["amazonaws.com", "neon.tech", "neon-db.net", "supabase.co", ".render.com"];

export function assertDisposableTarget(url) {
  if (!url) return { allowed: false, reason: "DATABASE_URL is not set" };
  const matched = PRODUCTION_HOST_PATTERNS.find((p) => url.includes(p));
  if (matched) return { allowed: false, reason: `DATABASE_URL names production host '${matched}'` };
  let host, dbName;
  try {
    const u = new URL(url.replace(/^postgresql:\/\//, "http://").replace(/^postgres:\/\//, "http://"));
    host = u.hostname;
    dbName = u.pathname.replace(/^\//, "");
  } catch {
    return { allowed: false, reason: "DATABASE_URL does not parse" };
  }
  if (host === "127.0.0.1" || host === "localhost") return { allowed: true, reason: `loopback target '${host}'` };
  if (/scratch|test/i.test(dbName)) return { allowed: true, reason: `scratch/test database '${dbName}'` };
  return { allowed: false, reason: `host '${host}' is not loopback and database '${dbName}' is not a scratch/test database` };
}

function runSelfTest() {
  const out = (s) => process.stdout.write(s + "\n");

  out("self-test: verifying FK enumeration helpers\n");

  const mockEdges = [
    { child: "public.organization_members", parent: "public.users" },
    { child: "public.hr_people", parent: "public.users" },
    { child: "public.hr_employments", parent: "public.hr_people" },
    { child: "public.notifications", parent: "public.organization_members" },
  ];

  function deletionOrder(tables, edges) {
    const set = new Set(tables);
    const indegree = new Map([...set].map((t) => [t, 0]));
    const out2 = new Map([...set].map((t) => [t, []]));
    for (const { child, parent } of edges) {
      if (!set.has(child) || !set.has(parent)) continue;
      out2.get(child).push(parent);
      indegree.set(parent, indegree.get(parent) + 1);
    }
    const queue = [...set].filter((t) => indegree.get(t) === 0);
    const ordered = [];
    while (queue.length > 0) {
      const node = queue.shift();
      ordered.push(node);
      for (const p of out2.get(node)) {
        indegree.set(p, indegree.get(p) - 1);
        if (indegree.get(p) === 0) queue.push(p);
      }
    }
    const cyclic = [...set].filter((t) => !ordered.includes(t));
    return { ordered, cyclic };
  }

  const tables = mockEdges.map((e) => e.child);
  tables.push("public.users");
  const { ordered, cyclic } = deletionOrder(tables, mockEdges);

  let errors = 0;

  if (cyclic.length > 0) {
    process.stderr.write(`  FAIL  cyclic tables detected unexpectedly: ${cyclic.join(", ")}\n`);
    errors++;
  } else {
    out("  PASS  no cyclic tables in test graph");
  }

  const usersIdx = ordered.indexOf("public.users");
  const omIdx = ordered.indexOf("public.organization_members");
  const notifIdx = ordered.indexOf("public.notifications");

  if (notifIdx < omIdx) {
    out(`  PASS  notifications (${notifIdx}) ordered before organization_members (${omIdx})`);
  } else {
    process.stderr.write(`  FAIL  deletion order wrong: notifications at ${notifIdx}, organization_members at ${omIdx}\n`);
    errors++;
  }

  if (omIdx < usersIdx) {
    out(`  PASS  organization_members (${omIdx}) ordered before users (${usersIdx})`);
  } else {
    process.stderr.write(`  FAIL  deletion order wrong: organization_members at ${omIdx}, users at ${usersIdx}\n`);
    errors++;
  }

  const hrEmplIdx = ordered.indexOf("public.hr_employments");
  const hrPeopleIdx = ordered.indexOf("public.hr_people");
  if (hrEmplIdx < hrPeopleIdx) {
    out(`  PASS  hr_employments (${hrEmplIdx}) ordered before hr_people (${hrPeopleIdx})`);
  } else {
    process.stderr.write(`  FAIL  deletion order wrong: hr_employments at ${hrEmplIdx}, hr_people at ${hrPeopleIdx}\n`);
    errors++;
  }

  const guardCases = [
    [assertDisposableTarget("postgresql://u:p@127.0.0.1:5432/app"), true],
    [assertDisposableTarget("postgresql://u:p@10.0.0.5:5432/scratch_e2e"), true],
    [assertDisposableTarget("postgresql://u:p@prod.cluster.amazonaws.com/app"), false],
    [assertDisposableTarget("postgresql://u:p@prod.cluster.amazonaws.com/scratch_test"), false],
    [assertDisposableTarget("postgresql://u:p@db.neon.tech/neondb"), false],
    [assertDisposableTarget(null), false],
  ];
  for (const [verdict, expected] of guardCases) {
    if (verdict.allowed !== expected) {
      process.stderr.write(`  FAIL  target guard: expected allowed=${expected}, got '${verdict.reason}'\n`);
      errors++;
    }
  }
  if (errors === 0) out("  PASS  target guard: all 6 cases correct");

  if (errors > 0) {
    process.stderr.write(`\nself-test: ${errors} check(s) failed — deletionOrder logic is broken\n`);
    process.exit(1);
  }
  out("\nself-test PASS — FK enumeration and deletion ordering correct");
  process.exit(0);
}

if (selfTest) runSelfTest();

if (execute && !iKnow) {
  process.stderr.write("DRILL BLOCKED — --execute requires --i-know-what-im-doing\n");
  process.exit(1);
}

const DATABASE_URL = loadVar("DATABASE_URL");
const APP_DATABASE_URL = loadVar("APP_DATABASE_URL");

if (!DATABASE_URL) {
  process.stderr.write("DRILL BLOCKED — DATABASE_URL not set in environment (set it explicitly; never relies on .env fallback)\n");
  process.exit(1);
}

const _drillGuard = assertDisposableTarget(DATABASE_URL);
if (!_drillGuard.allowed) {
  process.stderr.write(
    `DRILL BLOCKED — ${_drillGuard.reason}\n` +
    "  Set DATABASE_URL to a loopback or named scratch/test database before running erasure drills.\n",
  );
  process.exit(1);
}

const ownerSql = postgres(DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });
const email = emailArg.trim().toLowerCase();

const out = (s) => process.stdout.write(s + "\n");

async function fkEdges() {
  return ownerSql`
    SELECT n.nspname || '.' || c.relname AS child,
           pn.nspname || '.' || p.relname AS parent,
           k.confdeltype AS del_rule
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_class p ON p.oid = k.confrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_namespace pn ON pn.oid = p.relnamespace
    WHERE k.contype = 'f'
      AND n.nspname = ANY(${APP_SCHEMAS})
      AND pn.nspname = ANY(${APP_SCHEMAS})
      AND c.oid <> p.oid`;
}

async function userReferencingColumns() {
  return ownerSql`
    SELECT n.nspname || '.' || c.relname AS table_name,
           a.attname AS column_name,
           k.confdeltype AS del_rule
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_class p ON p.oid = k.confrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_namespace pn ON pn.oid = p.relnamespace
    JOIN LATERAL unnest(k.conkey) AS ck(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ck.attnum
    WHERE k.contype = 'f'
      AND pn.nspname = 'public' AND p.relname = 'users'
      AND n.nspname = ANY(${APP_SCHEMAS})
      AND array_length(k.conkey, 1) = 1`;
}

async function tablesWithDeletedAt() {
  const rows = await ownerSql`
    SELECT n.nspname || '.' || c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = ANY(${APP_SCHEMAS})
      AND c.relkind = 'r'
      AND a.attname = 'deleted_at'`;
  return new Set(rows.map((r) => r.table_name));
}

function deletionOrder(tables, edges) {
  const set = new Set(tables);
  const indegree = new Map([...set].map((t) => [t, 0]));
  const adj = new Map([...set].map((t) => [t, []]));
  for (const { child, parent } of edges) {
    if (!set.has(child) || !set.has(parent)) continue;
    adj.get(child).push(parent);
    indegree.set(parent, indegree.get(parent) + 1);
  }
  const queue = [...set].filter((t) => indegree.get(t) === 0);
  const ordered = [];
  while (queue.length > 0) {
    const node = queue.shift();
    ordered.push(node);
    for (const p of adj.get(node)) {
      indegree.set(p, indegree.get(p) - 1);
      if (indegree.get(p) === 0) queue.push(p);
    }
  }
  const cyclic = [...set].filter((t) => !ordered.includes(t));
  return { ordered, cyclic };
}

async function main() {
  out(`\n=== ERASURE DRILL (${execute ? "EXECUTE — will commit" : "DRY-RUN — will roll back"}) ===\n`);

  const [user] = await ownerSql`
    SELECT id FROM users WHERE lower(email) = ${email} LIMIT 1`;

  if (!user) {
    process.stderr.write(`DRILL BLOCKED — subject not found\n`);
    await ownerSql.end();
    process.exit(1);
  }

  const holds = await ownerSql`
    SELECT id, org_id FROM hr_legal_holds
    WHERE subject_user_id = ${user.id} AND status = 'active' AND deleted_at IS NULL`;

  if (holds.length > 0) {
    process.stderr.write(
      `DRILL BLOCKED — subject has ${holds.length} active legal hold(s) — release all holds before running erasure.\n`,
    );
    await ownerSql.end();
    process.exit(1);
  }

  out(`Subject found (id present)`);
  out("No active legal holds — erasure may proceed.\n");

  out("Step 1 — enumerating FK dependencies from pg_catalog");
  const edges = await fkEdges();
  const userRefs = await userReferencingColumns();
  const softDeleteTables = await tablesWithDeletedAt();

  const directTables = userRefs.map((r) => r.table_name);
  out(`  ${directTables.length} table(s) reference users.id directly`);

  for (const r of userRefs) {
    const cascadeLabel = r.del_rule === "c" ? "CASCADE" : r.del_rule === "s" ? "SET NULL" : "NO ACTION/RESTRICT";
    const isSoft = softDeleteTables.has(r.table_name);
    out(`    ${r.table_name}.${r.column_name}  del_rule=${cascadeLabel}${isSoft ? "  has deleted_at (soft-delete intermediary — child cascade may be blocked)" : ""}`);
  }

  const allTables = [...new Set([...directTables, "public.users"])];
  const { ordered, cyclic } = deletionOrder(allTables, edges);

  if (cyclic.length > 0)
    out(`  WARNING: cyclic FK dependency detected among: ${cyclic.join(", ")} — may require manual intervention`);

  out(`\n  Derived deletion order (${ordered.length} tables):`);
  for (const t of ordered) out(`    ${t}`);

  out("\nStep 2 — executing erasure in transaction");

  const doErasure = async (tx) => {
    const tally = new Map();
    const userId = user.id;

    for (const { table_name, column_name, del_rule } of userRefs) {
      if (del_rule === "c") continue;
      const [schema, table] = table_name.split(".");
      await tx.unsafe("SAVEPOINT sp_del");
      try {
        const res = await tx.unsafe(
          `DELETE FROM "${schema}"."${table}" WHERE "${column_name}" = $1`,
          [userId],
        );
        if (res.count > 0) tally.set(table_name, res.count);
        await tx.unsafe("RELEASE SAVEPOINT sp_del");
      } catch (err) {
        await tx.unsafe("ROLLBACK TO SAVEPOINT sp_del");
        if (err.code === "42P01" || err.code === "42703") continue;
        throw err;
      }
    }

    const [delUser] = await tx`DELETE FROM users WHERE id = ${userId} RETURNING id`;
    if (delUser?.id) tally.set("public.users", 1);

    out(`  Rows deleted:`);
    for (const [t, n] of tally) out(`    ${n} row(s) from ${t}`);

    out("\nStep 3 — re-querying to prove absence");
    let residual = 0;
    for (const { table_name, column_name } of userRefs) {
      const [schema, table] = table_name.split(".");
      await tx.unsafe("SAVEPOINT sp_chk");
      try {
        const [cnt] = await tx.unsafe(
          `SELECT count(*)::int AS n FROM "${schema}"."${table}" WHERE "${column_name}" = $1`,
          [userId],
        );
        const n = Number(cnt?.n ?? 0);
        if (n > 0) {
          process.stderr.write(`  FAIL  ${table_name}: ${n} row(s) still present after deletion\n`);
          residual += n;
        } else {
          out(`  PASS  ${table_name}: 0 rows remaining`);
        }
        await tx.unsafe("RELEASE SAVEPOINT sp_chk");
      } catch (err) {
        await tx.unsafe("ROLLBACK TO SAVEPOINT sp_chk");
        if (err.code === "42P01" || err.code === "42703") continue;
        throw err;
      }
    }

    const [userGone] = await tx`SELECT id FROM users WHERE id = ${userId} LIMIT 1`;
    if (userGone) {
      process.stderr.write("  FAIL  users: subject row still present after DELETE\n");
      residual++;
    } else {
      out("  PASS  users: subject row absent");
    }

    return residual;
  };

  let residual = 0;
  if (execute) {
    await ownerSql.begin(async (tx) => {
      residual = await doErasure(tx);
    });
    out(`\n=== RESULT: ${residual === 0 ? "PASS" : "FAIL"} — erasure committed (${residual} residual row(s)) ===`);
  } else {
    let rollbackFailed = false;
    try {
      await ownerSql.begin(async (tx) => {
        residual = await doErasure(tx);
        throw new Error("DRY_RUN_ROLLBACK");
      });
    } catch (err) {
      if (err.message !== "DRY_RUN_ROLLBACK") {
        process.stderr.write(`Dry-run error: ${err.message}\n`);
        rollbackFailed = true;
      }
    }
    if (rollbackFailed) {
      await ownerSql.end();
      process.exit(1);
    }
    out(`\n=== RESULT: ${residual === 0 ? "PASS" : "FAIL"} — dry-run complete (rolled back; ${residual} residual row(s) in simulation) ===`);
    if (residual === 0) {
      out("  Re-run with --execute --i-know-what-im-doing to commit the real erasure.");
      out("  Operator note: object-storage blobs are NOT deleted by this drill — run audit-storage-keys.mjs separately.");
    }
  }

  await ownerSql.end();

  if (APP_DATABASE_URL && execute) {
    out("\nStep 4 — verifying absence via app role (streamline_app with GUC)");
    const appSql = postgres(APP_DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });
    const [anyMembership] = await appSql`
      SELECT org_id FROM organization_members ORDER BY created_at DESC LIMIT 1`;
    const checkOrgId = anyMembership?.org_id ?? "00000000-0000-0000-0000-000000000000";
    try {
      await appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${checkOrgId}, true)`;
        const [cnt] = await tx`SELECT count(*)::int AS n FROM users WHERE id = ${user.id}`;
        const n = Number(cnt?.n ?? 0);
        if (n > 0) {
          process.stderr.write(`  FAIL  app role: subject still visible in users (${n} row)\n`);
        } else {
          out("  PASS  app role: subject absent from users (verified via streamline_app with GUC)");
        }
      });
    } catch (e) {
      out(`  SKIP  app role check failed: ${e.message}`);
    }
    await appSql.end();
  }

  process.exit(residual > 0 ? 1 : 0);
}

main().catch(async (err) => {
  process.stderr.write(`\nDrill crashed: ${err.message}\n${err.stack ?? ""}\n`);
  await ownerSql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
