import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as dotenv from "dotenv";
import { BUDGETS } from "./read-cost-budgets.mjs";

export function validateBudgets(budgets) {
  const errors = [];
  for (let i = 0; i < budgets.length; i++) {
    const b = budgets[i];
    const tag = `budget[${i}]${typeof b?.id === "string" ? ` "${b.id}"` : ""}`;
    if (!b || typeof b !== "object") { errors.push(`${tag}: must be an object`); continue; }
    if (typeof b.id !== "string" || !b.id) errors.push(`${tag}: id must be a non-empty string`);
    if (typeof b.ceiling !== "number" || b.ceiling < 0 || !Number.isFinite(b.ceiling))
      errors.push(`${tag}: ceiling must be a finite non-negative number`);
    if (typeof b.minRows !== "number" || b.minRows < 1 || !Number.isFinite(b.minRows))
      errors.push(`${tag}: minRows must be a positive finite number`);
    if (typeof b.rowCountSql !== "string" || !b.rowCountSql.trim())
      errors.push(`${tag}: rowCountSql must be a non-empty string`);
    if (typeof b.sql !== "string" || !b.sql.trim())
      errors.push(`${tag}: sql must be a non-empty string`);
    if (typeof b.params !== "function")
      errors.push(`${tag}: params must be a function`);
    if (!Array.isArray(b.planAssertions)) {
      errors.push(`${tag}: planAssertions must be an array`);
    } else {
      for (let j = 0; j < b.planAssertions.length; j++) {
        const a = b.planAssertions[j];
        const atag = `${tag}.planAssertions[${j}]`;
        if (typeof a?.kind !== "string") errors.push(`${atag}: kind must be a string`);
        if (typeof a?.relation !== "string" || !a.relation)
          errors.push(`${atag}: relation must be a non-empty string`);
      }
    }
  }
  return errors;
}

export function walk(node, out) {
  out.push({
    type: node["Node Type"],
    relation: node["Relation Name"] ?? null,
    index: node["Index Name"] ?? null,
  });
  (node.Plans ?? []).forEach((child) => walk(child, out));
  return out;
}

export function extractScans(node, out = []) {
  const t = node["Node Type"];
  if (
    ["Seq Scan", "Index Scan", "Index Only Scan", "Bitmap Heap Scan"].includes(t) &&
    node["Relation Name"]
  ) {
    out.push({
      relation: node["Relation Name"],
      actualRows: node["Actual Rows"] ?? 0,
      removedByFilter:
        (node["Rows Removed by Filter"] ?? 0) +
        (node["Rows Removed by Index Recheck"] ?? 0),
    });
  }
  for (const child of node.Plans ?? []) extractScans(child, out);
  return out;
}

export function checkPlanAssertions(planAssertions, nodes, budgetId) {
  const failures = [];
  for (const assertion of planAssertions ?? []) {
    if (assertion.kind === "require-index-only-scan") {
      const node = nodes.find((n) => n.relation === assertion.relation);
      if (!node) {
        failures.push(
          `${budgetId}: no ${assertion.relation} node — query shape changed, assertion is vacuous`,
        );
      } else if (!node.type.startsWith("Index Only Scan")) {
        failures.push(
          `${budgetId}: ${assertion.relation} resolved by ${node.type}, not Index Only Scan — tenant-led covering index missing or unusable`,
        );
      }
    } else if (assertion.kind === "forbid-seq-scan") {
      const node = nodes.find((n) => n.relation === assertion.relation);
      if (node && node.type === "Seq Scan") {
        failures.push(
          `${budgetId}: ${assertion.relation} resolved by Seq Scan — index dropped, missing or statistics stale`,
        );
      }
    } else {
      failures.push(`${budgetId}: unknown assertion kind "${assertion.kind}"`);
    }
  }
  return failures;
}

<<<<<<< HEAD
async function runBudget(budget, fixtures, db, orgId, assumeRole) {
=======
async function runBudget(budget, fixtures, dbUrl, ssl, orgId) {
>>>>>>> origin/main
  const params = budget.params(fixtures);
  if (params === null)
    return { status: "skip", reason: "no fixture data for this budget" };

  const db = postgres(dbUrl, { max: 1, prepare: false, ssl, onnotice: () => {} });
  try {
    return await db.begin(async (tx) => {
      // Measuring as the owner is measuring nothing: neondb_owner has
      // BYPASSRLS, so the tenant predicate never appears in the plan and every
      // cost this harness exists to catch is invisible. Assuming the app role
      // for the transaction gets a genuine plan without needing a password
      // Neon cannot durably hold.
      if (assumeRole) await tx.unsafe(`SET LOCAL ROLE ${assumeRole}`);
      await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;

      const [{ count }] = await tx.unsafe(budget.rowCountSql, [orgId]);
      const tableRows = Number(count);
      if (tableRows < budget.minRows)
        return { status: "seed-too-small", measured: tableRows, required: budget.minRows };

      const plan1 = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${budget.sql}`, params);
      const root1 = plan1[0]["QUERY PLAN"][0].Plan;
      const hit1 = root1["Shared Hit Blocks"] ?? 0;
      const read1 = root1["Shared Read Blocks"] ?? 0;

      const plan2 = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${budget.sql}`, params);
      const root2 = plan2[0]["QUERY PLAN"][0].Plan;
      const hit2 = root2["Shared Hit Blocks"] ?? 0;
      const read2 = root2["Shared Read Blocks"] ?? 0;

      const nodes = walk(root1, []);
      const scans = extractScans(root1);
      const assertionFailures = checkPlanAssertions(budget.planAssertions, nodes, budget.id);

      return {
        status: "measured",
        run1: { hitBlocks: hit1, readBlocks: read1, totalBlocks: hit1 + read1 },
        run2: { hitBlocks: hit2, readBlocks: read2, totalBlocks: hit2 + read2 },
        scans,
        tableRows,
        assertionFailures,
      };
    });
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  } finally {
    await db.end();
  }
}

async function main() {
  dotenv.config({ path: resolve(process.cwd(), ".env") });

  // Two ways to reach a non-BYPASSRLS role. APP_DATABASE_URL connects as it
  // directly; APP_DB_ROLE connects as the owner and assumes it per
  // transaction, which is what this database needs -- Neon manages role
  // credentials in its control plane, so `streamline_app`'s password reverts
  // when the compute suspends and an app carrying it would break overnight.
  // Membership plus `WITH SET TRUE` costs nothing and cannot expire.
  const directUrl = process.env.APP_DATABASE_URL;
  const assumeRole = directUrl ? null : (process.env.APP_DB_ROLE ?? "streamline_app");
  const url = directUrl ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("APP_DATABASE_URL (or DATABASE_URL plus APP_DB_ROLE) is required.");
    process.exit(1);
  }

  const SELF_TEST = process.argv.includes("--self-test");

  const validationErrors = validateBudgets(BUDGETS);
  if (validationErrors.length > 0) {
    for (const e of validationErrors) console.error("INVALID BUDGET:", e);
    process.exit(1);
  }

  const idsArg = process.argv.find((a) => a.startsWith("--ids="));
  const filterIds = idsArg ? new Set(idsArg.slice("--ids=".length).split(",").filter(Boolean)) : null;

  const ssl = process.env.PGSSLMODE === "disable" ? false : "require";
  const db = postgres(url, { max: 1, prepare: false, ssl, onnotice: () => {} });

  let ORG = process.env.SEED_ORG_ID;
  if (!ORG) {
    const orgRows = await db`SELECT id FROM organizations LIMIT 20`;
    let bestOrg = null;
    let bestCount = 0;
    for (const { id } of orgRows) {
      try {
        const rows = await db.begin(async (tx) => {
          await tx`SELECT set_config('app.organization_id', ${id}, true)`;
          return tx.unsafe(
            `SELECT count(*)::int AS n FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE'`,
            [id],
          );
        });
        const n = rows[0]?.n ?? 0;
        if (n > bestCount) { bestCount = n; bestOrg = id; }
      } catch (_) {}
    }
    if (!bestOrg) {
      await db.end();
      console.error("SEED_ORG_ID not set and no org with active members found in the database.");
      console.error("Set SEED_ORG_ID in .env to a seeded org ID, or seed the database first.");
      process.exit(1);
    }
    ORG = bestOrg;
    if (!SELF_TEST) console.log(`Auto-discovered seed org: ${ORG} (${bestCount} active members)`);
  }

  try {
    // Self-test: use a budget whose params never returns null so the harness always exercises
    // the breach path. BUDGETS[0] (scoped-board-page) returns null when no project exists,
    // causing a SKIP that never touches breaches — a guard that cannot fail is useless.
    // org-members-list uses params: (f) => [f.orgId], which is always non-null.
    const selfTestBudget = BUDGETS.find((b) => b.id === "org-members-list") ?? BUDGETS[0];
    const budgets = SELF_TEST
      ? [{ ...selfTestBudget, id: "self-test", ceiling: 0 }]
      : filterIds
        ? BUDGETS.filter((b) => filterIds.has(b.id))
        : BUDGETS;

<<<<<<< HEAD
    // Fail closed. A misconfigured role here does not error -- it quietly
    // measures as the owner and reports comfortable numbers that mean nothing,
    // which is worse than not measuring at all.
    if (assumeRole) {
      const [effective] = await db.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${assumeRole}`);
        return tx`SELECT current_user,
                         (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`;
      });
      if (effective.bypass) {
        console.error(
          `Refusing to measure: ${effective.current_user} has BYPASSRLS, so every plan would omit the tenant predicate.`,
        );
        process.exit(1);
      }
      console.log(`Measuring as ${effective.current_user} (no BYPASSRLS).`);
    }

    const fixtures = await db.begin(async (tx) => {
      await tx`SELECT set_config('app.organization_id', ${ORG}, true)`;
=======
    const tryFixture = async (query) => {
      try {
        return await db.begin(async (tx) => {
          await tx`SELECT set_config('app.organization_id', ${ORG}, true)`;
          return query(tx);
        });
      } catch (_) {
        return null;
      }
    };
>>>>>>> origin/main

    const [project] = (await tryFixture((tx) => tx`
        SELECT project_id, count(*)::int n FROM build.tickets
        WHERE org_id = ${ORG} AND deleted_at IS NULL
        GROUP BY project_id ORDER BY n DESC LIMIT 1`)) ?? [null];

    const [participant] = (await tryFixture((tx) => tx`
        SELECT user_id, count(*)::int n FROM build.ticket_assignees
        WHERE org_id = ${ORG} GROUP BY user_id ORDER BY n DESC LIMIT 1`)) ?? [null];

    const [channel] = (await tryFixture((tx) => tx`
        SELECT channel_id, count(*)::int n FROM chat_messages
        WHERE org_id = ${ORG} GROUP BY channel_id ORDER BY n DESC LIMIT 1`)) ?? [null];

    const [space] = (await tryFixture((tx) => tx`
        SELECT id AS space_id FROM kb_spaces
        WHERE org_id = ${ORG} LIMIT 1`)) ?? [null];

    const [payrollRun] = (await tryFixture((tx) => tx`
        SELECT id AS run_id FROM payroll_runs
        WHERE org_id = ${ORG} ORDER BY id DESC LIMIT 1`)) ?? [null];

    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const leaveTypeRows = (await tryFixture((tx) => tx`
        SELECT DISTINCT leave_type_id
        FROM leave_policies
        WHERE org_id = ${ORG} AND accrual_type = 'MONTHLY' AND is_active = true`)) ?? [];
    const leaveTypeIds = leaveTypeRows.map((r) => r.leave_type_id);

<<<<<<< HEAD
      // G1. Page two of a keyset walk starts where page one ended, so the
      // fixture is the 51st row in the list's own order. The timestamp is read
      // as text at full precision, exactly as the endpoint projects it -- a
      // boundary that went through a JS Date would name a different instant.
      const [ledgerCursor] = await tx`
        SELECT to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS cursor_at, id
        FROM inv_stock_transactions
        WHERE org_id = ${ORG}
        ORDER BY created_at DESC, id DESC
        OFFSET 50 LIMIT 1`;

      const [auditCursor] = await tx`
        SELECT to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS cursor_at, id
        FROM inv_audit_events
        WHERE org_id = ${ORG}
        ORDER BY created_at DESC, id DESC
        OFFSET 10 LIMIT 1`;

      return {
        ledgerCursorAt: ledgerCursor?.cursor_at ?? null,
        ledgerCursorId: ledgerCursor?.id ?? null,
        auditCursorAt: auditCursor?.cursor_at ?? null,
        auditCursorId: auditCursor?.id ?? null,
=======
    const [kbPageProbe] = (await tryFixture((tx) => tx`
        SELECT 1 AS present FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname = 'search_kb_page_ids'
        LIMIT 1`)) ?? [null];

    const [roadmapRow] = (await tryFixture((tx) => tx`
        SELECT 1 FROM build.roadmap_items WHERE org_id = ${ORG} LIMIT 1`)) ?? [null];

    const [feedbackRow] = (await tryFixture((tx) => tx`
        SELECT 1 FROM build.feedback_posts WHERE org_id = ${ORG} LIMIT 1`)) ?? [null];

    const [changelogRow] = (await tryFixture((tx) => tx`
        SELECT 1 FROM build.changelog_entries WHERE org_id = ${ORG} LIMIT 1`)) ?? [null];

    const [taxPaymentRow] = (await tryFixture((tx) => tx`
        SELECT 1 FROM acc_tax_payments WHERE org_id = ${ORG} LIMIT 1`)) ?? [null];

    const [reminderPolicyRow] = (await tryFixture((tx) => tx`
        SELECT 1 FROM fin_reminder_policies WHERE org_id = ${ORG} LIMIT 1`)) ?? [null];

    const [mailMessageRow] = (await tryFixture((tx) => tx`
        SELECT 1 FROM mail_message_metadata WHERE org_id = ${ORG} LIMIT 1`)) ?? [null];

    const fixtures = {
>>>>>>> origin/main
        orgId: ORG,
        projectId: project?.project_id ?? null,
        projectTickets: project?.n ?? 0,
        userId: participant?.user_id ?? null,
        participationOrgWide: participant?.n ?? 0,
        channelId: channel?.channel_id ?? null,
        channelMessages: channel?.n ?? 0,
        spaceId: space?.space_id ?? null,
        payrollRunId: payrollRun?.run_id ?? null,
        leaveTypeIds,
        hasKbPageProbe: kbPageProbe !== undefined && kbPageProbe !== null,
        hasRoadmapItems: roadmapRow !== null && roadmapRow !== undefined,
        hasFeedbackPosts: feedbackRow !== null && feedbackRow !== undefined,
        hasChangelogEntries: changelogRow !== null && changelogRow !== undefined,
        hasTaxPayments: taxPaymentRow !== null && taxPaymentRow !== undefined,
        hasReminderPolicies: reminderPolicyRow !== null && reminderPolicyRow !== undefined,
        hasMailMessages: mailMessageRow !== null && mailMessageRow !== undefined,
        period,
      };

    if (!SELF_TEST) {
      console.log(
        `org ${fixtures.orgId}` +
          ` · project ${fixtures.projectId} (${fixtures.projectTickets} tickets)` +
          ` · participant ${fixtures.userId} (${fixtures.participationOrgWide} rows)` +
          ` · channel ${fixtures.channelId} (${fixtures.channelMessages} msgs)` +
          ` · space ${fixtures.spaceId} · payroll run ${fixtures.payrollRunId}` +
          ` · leave types ${fixtures.leaveTypeIds.length} (period ${fixtures.period})` +
          ` · ledger cursor ${fixtures.ledgerCursorId ?? "none"}` +
          ` · audit cursor ${fixtures.auditCursorId ?? "none"}`,
      );
      console.log(`\nRunning ${budgets.length} budgets…\n`);
    }

    const breaches = [];
    const unusable = [];
    let skipped = 0;

    for (const budget of budgets) {
<<<<<<< HEAD
      const result = await runBudget(budget, fixtures, db, ORG, assumeRole);
=======
      const result = await runBudget(budget, fixtures, url, ssl, ORG);
>>>>>>> origin/main

      if (result.status === "skip") {
        if (!SELF_TEST)
          console.log(`SKIP  ${budget.id.padEnd(36)} (${result.reason})`);
        else unusable.push(`${budget.id}: skipped — ${result.reason}`);
        skipped++;
        continue;
      }

      if (result.status === "seed-too-small") {
        const label = `FAIL  ${budget.id.padEnd(36)} seed too small (${result.measured} < ${result.required})`;
        const detail = `${budget.id}: seed too small — ${result.measured} rows, need ${result.required}`;
        if (SELF_TEST) unusable.push(detail);
        else {
          breaches.push(detail);
          console.error(label);
        }
        continue;
      }

      if (result.status === "error") {
        const label = `FAIL  ${budget.id.padEnd(36)} error: ${result.message}`;
        if (SELF_TEST) unusable.push(`${budget.id}: ${result.message}`);
        else {
          breaches.push(`${budget.id}: ${result.message}`);
          console.error(label);
        }
        continue;
      }

      const { run1, run2, scans, tableRows, assertionFailures } = result;
      const totalBlocks = run1.totalBlocks;
      const overCeiling = totalBlocks > budget.ceiling;
      const ok = !overCeiling && assertionFailures.length === 0;

      if (!SELF_TEST) {
        const primaryScan = scans.length > 0
          ? scans.reduce((a, b) =>
              a.actualRows + a.removedByFilter >= b.actualRows + b.removedByFilter ? a : b)
          : null;
        const scanTotal = primaryScan ? primaryScan.actualRows + primaryScan.removedByFilter : 0;
        const sel = primaryScan && scanTotal > 0
          ? `${((primaryScan.actualRows / scanTotal) * 100).toFixed(0)}%`
          : "n/a";
        const coldTag = run1.readBlocks > 0 ? "!" : " ";
        console.log(
          `${ok ? "PASS" : "FAIL"}  ${budget.id.padEnd(36)}` +
          ` r1:h=${String(run1.hitBlocks).padStart(5)} rd=${String(run1.readBlocks).padStart(4)}${coldTag}` +
          ` r2:h=${String(run2.hitBlocks).padStart(5)} rd=${String(run2.readBlocks).padStart(4)}` +
          `  ceil=${budget.ceiling}  tbl=${tableRows} scan=${scanTotal} sel=${sel}`,
        );
        for (const f of assertionFailures) console.error(`        assertion: ${f}`);
      }

      if (overCeiling)
        breaches.push(`${budget.id}: ${totalBlocks} blocks > ceiling ${budget.ceiling}`);
      else if (SELF_TEST && run1.totalBlocks === 0)
        unusable.push(`${budget.id}: run1.totalBlocks=0 — budget measured nothing`);
      for (const f of assertionFailures) breaches.push(f);
    }

    if (SELF_TEST) {
      if (unusable.length > 0) {
        console.error(
          "SELF-TEST INCONCLUSIVE: the fixture never produced a measurement, so the ceiling was never tested.",
        );
        for (const u of unusable) console.error(`  UNUSABLE: ${u}`);
        process.exitCode = 1;
        return;
      }
      if (breaches.length > 0) {
        console.log("SELF-TEST PASS: breach detected — guard can fail");
        process.exitCode = 0;
      } else {
        console.error(
          "SELF-TEST FAIL: impossible ceiling (0) was not detected — guard cannot fail",
        );
        process.exitCode = 1;
      }
      return;
    }

    if (skipped > 0)
      console.log(`\n${skipped} budget(s) skipped (no fixture data — seed the relevant tables).`);

    if (breaches.length > 0) {
      console.error(`\n${breaches.length} breach(es):`);
      for (const b of breaches) console.error(`  FAIL: ${b}`);
      process.exitCode = 1;
      return;
    }

    console.log("\nAll budgets within ceiling.");
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
