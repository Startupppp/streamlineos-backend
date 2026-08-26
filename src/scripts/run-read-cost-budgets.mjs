import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as dotenv from "dotenv";
import { BUDGETS } from "./read-cost-budgets.mjs";

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

async function runBudget(budget, fixtures, db, orgId) {
  const params = budget.params(fixtures);
  if (params === null)
    return { status: "skip", reason: "no fixture data for this budget" };

  try {
    return await db.begin(async (tx) => {
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

  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    console.error("APP_DATABASE_URL is required (the non-BYPASSRLS app role).");
    process.exit(1);
  }

  const ORG = process.env.SEED_ORG_ID ?? "aa5627a2-a7de-4dca-97d2-135f3a5f801b";
  const SELF_TEST = process.argv.includes("--self-test");
  const ssl = process.env.PGSSLMODE === "disable" ? false : "require";
  const db = postgres(url, { max: 1, prepare: false, ssl, onnotice: () => {} });

  try {
    const budgets = SELF_TEST
      ? [{ ...BUDGETS[0], id: "self-test", ceiling: 0 }]
      : BUDGETS;

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

      return {
        orgId: ORG,
        projectId: project?.project_id ?? null,
        projectTickets: project?.n ?? 0,
        userId: participant?.user_id ?? null,
        participationOrgWide: participant?.n ?? 0,
        channelId: channel?.channel_id ?? null,
        channelMessages: channel?.n ?? 0,
        spaceId: space?.space_id ?? null,
        payrollRunId: payrollRun?.run_id ?? null,
      };
    });

    if (!SELF_TEST) {
      console.log(
        `org ${fixtures.orgId}` +
          ` · project ${fixtures.projectId} (${fixtures.projectTickets} tickets)` +
          ` · participant ${fixtures.userId} (${fixtures.participationOrgWide} rows)` +
          ` · channel ${fixtures.channelId} (${fixtures.channelMessages} msgs)` +
          ` · space ${fixtures.spaceId} · payroll run ${fixtures.payrollRunId}`,
      );
      console.log(`\nRunning ${budgets.length} budgets…\n`);
    }

    const breaches = [];
    let skipped = 0;

    for (const budget of budgets) {
      const result = await runBudget(budget, fixtures, db, ORG);

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
