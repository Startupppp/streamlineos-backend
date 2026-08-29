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

async function runBudget(budget, fixtures, db, orgId, assumeRole) {
  const params = budget.params(fixtures);
  if (params === null)
    return { status: "skip", reason: "no fixture data for this budget" };

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
      const rowCount = Number(count);
      if (rowCount < budget.minRows)
        return { status: "seed-too-small", measured: rowCount, required: budget.minRows };

      const rows = await tx.unsafe(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${budget.sql}`,
        params,
      );
      const root = rows[0]["QUERY PLAN"][0].Plan;
      const blocks = (root["Shared Hit Blocks"] ?? 0) + (root["Shared Read Blocks"] ?? 0);
      const nodes = walk(root, []);
      const assertionFailures = checkPlanAssertions(budget.planAssertions, nodes, budget.id);
      return { status: "measured", blocks, assertionFailures };
    });
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
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

  const ORG = process.env.SEED_ORG_ID ?? "aa5627a2-a7de-4dca-97d2-135f3a5f801b";
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

  try {
    const budgets = SELF_TEST
      ? [{ ...BUDGETS[0], id: "self-test", ceiling: 0 }]
      : filterIds
        ? BUDGETS.filter((b) => filterIds.has(b.id))
        : BUDGETS;

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

      const [project] = await tx`
        SELECT project_id, count(*)::int n FROM build.tickets
        WHERE org_id = ${ORG} AND deleted_at IS NULL
        GROUP BY project_id ORDER BY n DESC LIMIT 1`;

      const [participant] = await tx`
        SELECT user_id, count(*)::int n FROM build.ticket_assignees
        WHERE org_id = ${ORG} GROUP BY user_id ORDER BY n DESC LIMIT 1`;

      const [channel] = await tx`
        SELECT channel_id, count(*)::int n FROM chat_messages
        WHERE org_id = ${ORG} GROUP BY channel_id ORDER BY n DESC LIMIT 1`;

      const [space] = await tx`
        SELECT id AS space_id FROM kb_spaces
        WHERE org_id = ${ORG} LIMIT 1`;

      const [payrollRun] = await tx`
        SELECT id AS run_id FROM payroll_runs
        WHERE org_id = ${ORG} ORDER BY id DESC LIMIT 1`;

      const now = new Date();
      const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

      const leaveTypePolicies = await tx`
        SELECT DISTINCT leave_type_id
        FROM leave_policies
        WHERE org_id = ${ORG} AND accrual_type = 'MONTHLY' AND is_active = true`;
      const leaveTypeIds = leaveTypePolicies.map((r) => r.leave_type_id);

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
        period,
      };
    });

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
    let skipped = 0;

    for (const budget of budgets) {
      const result = await runBudget(budget, fixtures, db, ORG, assumeRole);

      if (result.status === "skip") {
        if (!SELF_TEST)
          console.log(`SKIP  ${budget.id.padEnd(36)} (${result.reason})`);
        skipped++;
        continue;
      }

      if (result.status === "seed-too-small") {
        const label = `FAIL  ${budget.id.padEnd(36)} seed too small (${result.measured} < ${result.required})`;
        breaches.push(`${budget.id}: seed too small — ${result.measured} rows, need ${result.required}`);
        if (!SELF_TEST) console.error(label);
        continue;
      }

      if (result.status === "error") {
        const label = `FAIL  ${budget.id.padEnd(36)} error: ${result.message}`;
        breaches.push(`${budget.id}: ${result.message}`);
        if (!SELF_TEST) console.error(label);
        continue;
      }

      const { blocks, assertionFailures } = result;
      const overCeiling = blocks > budget.ceiling;
      const ok = !overCeiling && assertionFailures.length === 0;

      if (!SELF_TEST) {
        console.log(
          `${ok ? "PASS" : "FAIL"}  ${budget.id.padEnd(36)}` +
            ` blocks=${String(blocks).padStart(7)} (ceiling ${budget.ceiling})`,
        );
        for (const f of assertionFailures) console.error(`        assertion: ${f}`);
      }

      if (overCeiling)
        breaches.push(`${budget.id}: ${blocks} blocks > ceiling ${budget.ceiling}`);
      for (const f of assertionFailures) breaches.push(f);
    }

    if (SELF_TEST) {
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
