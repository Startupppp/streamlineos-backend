import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import { BUDGETS, REQUIRED_BUDGET_IDS } from "./read-cost-budgets.mjs";
import { createScriptSql } from "./lib/script-sql-client.mjs";
import {
  formatRoleProvenance,
  resolveAppDatabaseUrl,
  resolveSsl,
  roleRefusal,
} from "./benchmark-role-guard.mjs";

export const KNOWN_ASSERTION_KINDS = new Set([
  "require-index-only-scan",
  "forbid-seq-scan",
  "forbid-hashed-subplan",
]);

export function rowCountPlaceholders(sql) {
  let highest = 0;
  for (const match of sql.matchAll(/\$(\d+)/g)) highest = Math.max(highest, Number(match[1]));
  return highest;
}

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
    if (typeof b.rowCountSql !== "string" || !b.rowCountSql.trim()) {
      errors.push(`${tag}: rowCountSql must be a non-empty string`);
    } else if (rowCountPlaceholders(b.rowCountSql) > 1 && typeof b.rowCountParams !== "function") {
      // The count runs with [orgId] alone unless the budget says otherwise, so a bare $2 here
      // is not a narrower count — it is a bind error, and the budget measures nothing at all.
      errors.push(
        `${tag}: rowCountSql references $2 or beyond but declares no rowCountParams — the count ` +
        `would be bound with [orgId] alone and fail at bind time`,
      );
    }
    if (b.rowCountParams !== undefined && typeof b.rowCountParams !== "function")
      errors.push(`${tag}: rowCountParams must be a function when present`);
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
        else if (!KNOWN_ASSERTION_KINDS.has(a.kind))
          errors.push(
            `${atag}: unknown kind "${a.kind}" — known kinds are ${[...KNOWN_ASSERTION_KINDS].join(", ")}`,
          );
        if (typeof a?.relation !== "string" || !a.relation)
          errors.push(`${atag}: relation must be a non-empty string`);
      }
    }
    if (b.maxScanRows !== undefined) {
      if (typeof b.maxScanRows !== "number" || b.maxScanRows < 0 || !Number.isFinite(b.maxScanRows))
        errors.push(`${tag}: maxScanRows must be a finite non-negative number`);
    }
    if (b.allowEmptyResult !== undefined) {
      if (typeof b.allowEmptyResult !== "boolean")
        errors.push(`${tag}: allowEmptyResult must be a boolean when present`);
      else if (b.allowEmptyResult === true && (typeof b.allowEmptyReason !== "string" || !b.allowEmptyReason.trim()))
        errors.push(
          `${tag}: allowEmptyResult: true must carry allowEmptyReason — waiving the vacuous-result ` +
          `guard without a written reason is how a budget stops measuring anything`,
        );
    }
  }
  return errors;
}

const QUAL_FIELDS = [
  "Filter",
  "Join Filter",
  "Index Cond",
  "Recheck Cond",
  "Hash Cond",
  "Merge Cond",
  "One-Time Filter",
  "TID Cond",
];

export function walk(node, out, subplanScope = null) {
  const quals = QUAL_FIELDS.map((f) => node[f]).filter((v) => typeof v === "string").join(" ");
  const scope = typeof node["Subplan Name"] === "string" ? node["Subplan Name"] : subplanScope;
  out.push({
    type: node["Node Type"],
    relation: node["Relation Name"] ?? null,
    index: node["Index Name"] ?? null,
    quals,
    subplanScope: scope,
  });
  (node.Plans ?? []).forEach((child) => walk(child, out, scope));
  return out;
}

/**
 * A hashed SubPlan is the planner de-correlating an `EXISTS`/`IN` and materialising the
 * WHOLE inner relation before the outer qual can short-circuit. It shows up as
 * `(hashed SubPlan N)` in the qual that references it, and the cost is O(inner relation),
 * not O(page) — so it is invisible on a small tenant, invisible on a warm cache, and
 * invisible in any fixture that happens not to reach the row that triggers it.
 *
 * That last property is why this assertion exists: `GET /calendar/events` and
 * `GET /dashboard/personal` both carried one, and neither could be pinned by a block
 * ceiling because whether the plan is reached depends on which rows fall in the window
 * — the same query measured 6 blocks on one run and 1,140 on the next. The plan shape
 * is order-independent where the number is not.
 */
export function hashedSubplanNames(nodes) {
  const names = new Set();
  for (const node of nodes)
    for (const match of node.quals.matchAll(/hashed (SubPlan \d+|InitPlan \d+)/g)) names.add(match[1]);
  return names;
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

export function percentile(sorted, q) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = q * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export function summarise(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    minMs: round3(sorted[0] ?? 0),
    p50Ms: round3(percentile(sorted, 0.5)),
    p95Ms: round3(percentile(sorted, 0.95)),
    p99Ms: round3(percentile(sorted, 0.99)),
    maxMs: round3(sorted[sorted.length - 1] ?? 0),
  };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
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
    } else if (assertion.kind === "forbid-hashed-subplan") {
      const hashed = hashedSubplanNames(nodes);
      const node = nodes.find((n) => n.relation === assertion.relation);
      if (!node) {
        failures.push(
          `${budgetId}: no ${assertion.relation} node — query shape changed, assertion is vacuous`,
        );
      } else {
        const offender = nodes.find(
          (n) => n.relation === assertion.relation && n.subplanScope !== null && hashed.has(n.subplanScope),
        );
        if (offender)
          failures.push(
            `${budgetId}: ${assertion.relation} is scanned inside a hashed ${offender.subplanScope} — the planner materialises the whole relation before the outer qual can short-circuit, so the cost is O(relation) and not O(page)`,
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

async function runBudget(budget, fixtures, dbUrl, ssl, orgId, samples, assumeRole) {
  const params = budget.params(fixtures);
  if (params === null)
    return { status: "skip", reason: "no fixture data for this budget" };

  const db = await createScriptSql({
    url: dbUrl,
    ssl,
    connection: { onnotice: () => {} },
  });
  try {
    return await db.begin(async (tx) => {
      // Measuring as the owner is measuring nothing: the owner has BYPASSRLS, so
      // the tenant predicate never appears in the plan and every cost this
      // harness exists to catch is invisible. Assuming the app role for the
      // transaction gets a genuine plan without needing a password Neon cannot
      // durably hold.
      if (assumeRole) await tx.unsafe(`SET LOCAL ROLE ${assumeRole}`);
      await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;

      const countParams = budget.rowCountParams ? budget.rowCountParams(fixtures) : [orgId];
      if (countParams === null)
        return { status: "skip", reason: "no fixture data for this budget's row count" };
      const [{ count }] = await tx.unsafe(budget.rowCountSql, countParams);
      const tableRows = Number(count);
      if (tableRows < budget.minRows)
        return { status: "seed-too-small", measured: tableRows, required: budget.minRows };

      const explain = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${budget.sql}`;
      const roots = [];
      const executionMs = [];
      const planningMs = [];
      for (let i = 0; i < samples; i++) {
        const plan = await tx.unsafe(explain, params);
        const wrapper = plan[0]["QUERY PLAN"][0];
        roots.push(wrapper.Plan);
        executionMs.push(wrapper["Execution Time"] ?? 0);
        planningMs.push(wrapper["Planning Time"] ?? 0);
      }

      const blocksOf = (root) => ({
        hitBlocks: root["Shared Hit Blocks"] ?? 0,
        readBlocks: root["Shared Read Blocks"] ?? 0,
        totalBlocks: (root["Shared Hit Blocks"] ?? 0) + (root["Shared Read Blocks"] ?? 0),
      });
      const root1 = roots[0];
      const rootLast = roots[roots.length - 1];

      const nodes = walk(root1, []);
      const scans = extractScans(root1);
      const assertionFailures = checkPlanAssertions(budget.planAssertions, nodes, budget.id);

      // The rows the query actually returned. A budget whose query matches nothing measures an
      // empty result set: every ceiling it declares is trivially satisfied and no plan regression
      // it exists to catch can ever fire. That is a vacuous budget, not a passing one.
      const resultRows = root1["Actual Rows"] ?? 0;

      const scanRowViolations = [];
      if (budget.maxScanRows !== undefined) {
        for (const scan of scans) {
          const total = scan.actualRows + scan.removedByFilter;
          if (total > budget.maxScanRows)
            scanRowViolations.push(
              `${budget.id}: ${scan.relation} scanned ${total} rows > maxScanRows ${budget.maxScanRows} — index not used or plan regressed`,
            );
        }
      }

      return {
        status: "measured",
        run1: blocksOf(root1),
        run2: blocksOf(rootLast),
        warmBlocks: Math.min(...roots.map((r) => blocksOf(r).totalBlocks)),
        latency: summarise(executionMs),
        planningMs: summarise(planningMs),
        coldMs: executionMs[0],
        scans,
        tableRows,
        resultRows,
        assertionFailures,
        scanRowViolations,
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

  const resolvedUrl = resolveAppDatabaseUrl(process.env);
  if (!resolvedUrl.ok) {
    console.error(resolvedUrl.why);
    process.exit(1);
  }
  const url = resolvedUrl.url;

  const SELF_TEST = process.argv.includes("--self-test");

  const validationErrors = validateBudgets(BUDGETS);
  if (validationErrors.length > 0) {
    for (const e of validationErrors) console.error("INVALID BUDGET:", e);
    process.exit(1);
  }

  const budgetIds = new Set(BUDGETS.map((b) => b.id));
  const missingRequired = [...REQUIRED_BUDGET_IDS].filter((id) => !budgetIds.has(id));
  if (missingRequired.length > 0) {
    for (const id of missingRequired)
      console.error(`MISSING REQUIRED BUDGET: "${id}" — add an entry to read-cost-budgets.mjs or the route is unguarded`);
    process.exit(1);
  }

  const idsArg = process.argv.find((a) => a.startsWith("--ids="));
  const filterIds = idsArg ? new Set(idsArg.slice("--ids=".length).split(",").filter(Boolean)) : null;

  const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? fallback : hit.slice(name.length + 3);
  };

  const SAMPLES = Math.max(2, Number(arg("samples", "2")) || 2);
  const JSON_OUT = arg("json", null);
  const PROFILE = arg("profile", "reference");
  if (PROFILE !== "reference" && PROFILE !== "minority") {
    console.error(`--profile must be "reference" or "minority", got "${PROFILE}"`);
    process.exit(1);
  }
  // On a minority tenant a budget whose org-scoped row count sits under its seed floor, or whose
  // query matches nothing, is UNMEASURED — not a breach. The floor exists to stop a degenerate
  // measurement being reported as a plan verdict; on a 0.18%-share tenant most floors are
  // unreachable by construction, and calling that a failure buries the handful of real results.
  // On the reference tenant both stay hard failures, so a shrinking seed can never go quiet.
  const STRICT = process.env.STREAMLINE_STRICT_BUDGETS === "1" || process.argv.includes("--strict");

  const ssl = resolveSsl(process.env);
  const db = await createScriptSql({
    url,
    ssl,
    connection: { onnotice: () => {} },
  });
  const assumeRole = process.env.APP_DB_ROLE ?? "streamline_app";

  // PRD-C079: the role is READ, never asserted. Every artifact this run writes carries the
  // value observed here, and measure-route-budgets.mjs refuses an artifact without it.
  const [connectedRole] = await db`
    SELECT current_user AS name, r.rolbypassrls, r.rolsuper
    FROM pg_roles r WHERE r.rolname = current_user`;
  let deniedWithoutGuc = false;
  try {
    await db`SELECT count(*) FROM calendar_events`;
  } catch (e) {
    if (e?.code === "42501") deniedWithoutGuc = true;
    else throw e;
  }
  const roleRefused = roleRefusal(connectedRole, deniedWithoutGuc);
  if (roleRefused) {
    console.error(roleRefused);
    await db.end();
    process.exit(1);
  }
  const ROLE_PROVENANCE = formatRoleProvenance(connectedRole);
  if (!SELF_TEST) console.log(`role ${ROLE_PROVENANCE} · no-GUC read denied 42501`);

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
    // Self-test: run three breach cases, one per ratchet type, to prove every guard can fail.
    // org-members-list uses params: (f) => [f.orgId], which is always non-null, so it never
    // skips — a guard that skips never touches the breach path and is useless.
    //
    // Breach type 1: block ceiling — impossible ceiling 0; any real query touches >0 blocks.
    // Breach type 2: plan assertion — require-index-only-scan on organization_members; the plan
    //   uses Bitmap Heap Scan (not Index Only Scan), so this assertion always fails.
    // Breach type 3: scan-rows — maxScanRows 0; any real query scans at least 1 row.
    //
    // Breach type 4: seed floor — an unreachable minRows must report seed-too-small.
    //
    // Breach type 6: hashed SubPlan — a de-correlated sublink that materialises the whole
    //   inner relation. Order-independent where a block ceiling is not.
    //
    // All six must breach; if any passes or skips, the self-test is inconclusive.
    //
    // The first three override minRows to 1. Inheriting the base budget's minRows
    // made the seed-size check fire first and short-circuit all three, so on any
    // database smaller than the base budget's seed the self-test reported
    // INCONCLUSIVE and proved nothing about the guards it exists to test. The
    // seed-size check is itself a guard, so it gets its own fixture rather than
    // standing in front of the others.
    const selfTestBase = BUDGETS.find((b) => b.id === "org-members-list") ?? BUDGETS[0];
    const budgets = SELF_TEST
      ? [
          { ...selfTestBase, id: "self-test-ceiling", ceiling: 0, minRows: 1 },
          { ...selfTestBase, id: "self-test-assertion", minRows: 1,
            planAssertions: [{ kind: "require-index-only-scan", relation: "organization_members" }] },
          { ...selfTestBase, id: "self-test-scan-rows", maxScanRows: 0, minRows: 1 },
          { ...selfTestBase, id: "self-test-seed-floor", minRows: Number.MAX_SAFE_INTEGER },
          // Breach type 5: vacuous — a query that matches nothing. Every ceiling it declares is
          // satisfied trivially, so without this guard an empty result set reports PASS.
          {
            ...selfTestBase,
            id: "self-test-vacuous",
            minRows: 1,
            maxScanRows: undefined,
            planAssertions: [],
            sql: `SELECT id FROM organization_members WHERE org_id = $1 AND 1 = 0`,
          },
          // Breach type 6: hashed SubPlan. `NOT IN (SELECT …)` cannot be pulled up into a
          // semi-join, so the planner de-correlates it and materialises the inner relation
          // — the same shape that hid a 39,114-row scan inside GET /calendar/events behind
          // a block count that only moved when the wall clock did.
          {
            ...selfTestBase,
            id: "self-test-hashed-subplan",
            minRows: 1,
            maxScanRows: undefined,
            planAssertions: [{ kind: "forbid-hashed-subplan", relation: "organization_members" }],
            sql: `
              SELECT id, user_id, role, is_owner, status, joined_at
              FROM organization_members
              WHERE org_id = $1 AND status = 'ACTIVE'
                AND id NOT IN (SELECT id FROM organization_members WHERE org_id = $1 AND status <> 'ACTIVE')
              ORDER BY joined_at DESC
              LIMIT 100`,
          },
        ]
      : filterIds
        ? BUDGETS.filter((b) => filterIds.has(b.id))
        : BUDGETS;

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

    const [project] = (await tryFixture((tx) => tx`
        SELECT project_id, count(*)::int n FROM build.tickets
        WHERE org_id = ${ORG} AND deleted_at IS NULL
        GROUP BY project_id ORDER BY n DESC LIMIT 1`)) ?? [null];

    const [participant] = (await tryFixture((tx) => tx`
        SELECT ta.membership_id, om.user_id, count(*)::int n
        FROM build.ticket_assignees ta
        INNER JOIN organization_members om ON om.org_id = ta.org_id AND om.id = ta.membership_id
        WHERE ta.org_id = ${ORG}
        GROUP BY ta.membership_id, om.user_id
        ORDER BY n DESC, ta.membership_id ASC LIMIT 1`)) ?? [null];

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

    const [calEventRow] = (await tryFixture((tx) => tx`
        SELECT 1 FROM calendar_events WHERE org_id = ${ORG} LIMIT 1`)) ?? [null];

    const [announcementRow] = (await tryFixture((tx) => tx`
        SELECT 1 FROM announcements WHERE org_id = ${ORG} LIMIT 1`)) ?? [null];

    // G1. Page two of a keyset walk starts where page one ended, so the fixture
    // is the 51st row in the list's own order. The timestamp is read as text at
    // full precision, exactly as the endpoint projects it -- a boundary that
    // went through a JS Date would name a different instant.
    const [ledgerCursor] = (await tryFixture((tx) => tx`
        SELECT to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS cursor_at, id
        FROM inv_stock_transactions
        WHERE org_id = ${ORG}
        ORDER BY created_at DESC, id DESC
        OFFSET 50 LIMIT 1`)) ?? [null];

    const [auditCursor] = (await tryFixture((tx) => tx`
        SELECT to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS cursor_at, id
        FROM inv_audit_events
        WHERE org_id = ${ORG}
        ORDER BY created_at DESC, id DESC
        OFFSET 10 LIMIT 1`)) ?? [null];
    const [businessPartyRow] = (await tryFixture((tx) => tx`
        SELECT 1 FROM business_parties WHERE organization_id = ${ORG} AND deleted_at IS NULL LIMIT 1`)) ?? [null];

    const [moduleRoleRow] = (await tryFixture((tx) => tx`
        SELECT 1 FROM roles WHERE org_id = ${ORG} AND module_key IS NOT NULL LIMIT 1`)) ?? [null];

    const fixtures = {
        ledgerCursorAt: ledgerCursor?.cursor_at ?? null,
        ledgerCursorId: ledgerCursor?.id ?? null,
        auditCursorAt: auditCursor?.cursor_at ?? null,
        auditCursorId: auditCursor?.id ?? null,
        orgId: ORG,
        projectId: project?.project_id ?? null,
        projectTickets: project?.n ?? 0,
        userId: participant?.user_id ?? null,
        membershipId: participant?.membership_id ?? null,
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
        hasCalendarEvents: calEventRow !== null && calEventRow !== undefined,
        hasAnnouncements: announcementRow !== null && announcementRow !== undefined,
        hasBusinessParties: businessPartyRow !== null && businessPartyRow !== undefined,
        hasModuleRoles: moduleRoleRow !== null && moduleRoleRow !== undefined,
        period,
      };

    if (!SELF_TEST) {
      console.log(
        `org ${fixtures.orgId}` +
          ` · project ${fixtures.projectId} (${fixtures.projectTickets} tickets)` +
          ` · participant ${fixtures.userId} (${fixtures.participationOrgWide} rows)` +
          ` · channel ${fixtures.channelId} (${fixtures.channelMessages} msgs)` +
          ` · space ${fixtures.spaceId} · payroll run ${fixtures.payrollRunId}` +
          ` · leave types ${fixtures.leaveTypeIds.length} (period ${fixtures.period})`,
      );
      console.log(`\nRunning ${budgets.length} budgets…\n`);
    }

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
      if (!SELF_TEST) console.log(`Measuring as ${effective.current_user} (no BYPASSRLS).`);
    }

    const breaches = [];
    const unusable = [];
    const unmeasured = [];
    const vacuous = [];
    const records = [];
    let skipped = 0;
    let excluded = 0;
    let passed = 0;

    for (const budget of budgets) {
      if (budget.excluded) {
        if (!SELF_TEST)
          console.log(`EXCL  ${budget.id.padEnd(36)} (${budget.excluded})`);
        excluded++;
        records.push({ id: budget.id, outcome: "excluded", reason: budget.excluded });
        continue;
      }

      const result = await runBudget(budget, fixtures, url, ssl, ORG, SAMPLES, assumeRole);

      if (result.status === "skip") {
        if (!SELF_TEST)
          console.log(`SKIP  ${budget.id.padEnd(36)} (${result.reason})`);
        else unusable.push(`${budget.id}: skipped — ${result.reason}`);
        skipped++;
        records.push({ id: budget.id, outcome: "skip", reason: result.reason });
        continue;
      }

      if (result.status === "seed-too-small") {
        const detail = `${budget.id}: seed too small — ${result.measured} rows, need ${result.required}`;
        if (SELF_TEST) {
          if (budget.id === "self-test-seed-floor") breaches.push(detail);
          else unusable.push(detail);
        } else if (PROFILE === "minority") {
          console.log(`UNMS  ${budget.id.padEnd(36)} below seed floor for this tenant (${result.measured} < ${result.required})`);
          unmeasured.push(detail);
        } else {
          breaches.push(detail);
          console.error(`FAIL  ${budget.id.padEnd(36)} seed too small (${result.measured} < ${result.required})`);
        }
        records.push({
          id: budget.id,
          outcome: PROFILE === "minority" ? "unmeasured" : "fail",
          reason: "seed-too-small",
          tenantRows: result.measured,
          minRows: result.required,
        });
        continue;
      }

      if (result.status === "error") {
        const label = `FAIL  ${budget.id.padEnd(36)} error: ${result.message}`;
        if (SELF_TEST) unusable.push(`${budget.id}: ${result.message}`);
        else {
          breaches.push(`${budget.id}: ${result.message}`);
          console.error(label);
        }
        records.push({ id: budget.id, outcome: "error", reason: result.message });
        continue;
      }

      const { run1, run2, scans, tableRows, resultRows, assertionFailures, scanRowViolations } = result;
      const totalBlocks = run1.totalBlocks;
      const overCeiling = totalBlocks > budget.ceiling;
      const isVacuous = resultRows === 0 && budget.allowEmptyResult !== true;
      const ok =
        !overCeiling && !isVacuous &&
        assertionFailures.length === 0 && scanRowViolations.length === 0;
      if (ok && !SELF_TEST) passed++;

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
        const verdict = ok ? "PASS" : isVacuous && PROFILE === "minority" ? "UNMS" : "FAIL";
        console.log(
          `${verdict}  ${budget.id.padEnd(36)}` +
          ` r1:h=${String(run1.hitBlocks).padStart(5)} rd=${String(run1.readBlocks).padStart(4)}${coldTag}` +
          ` r2:h=${String(run2.hitBlocks).padStart(5)} rd=${String(run2.readBlocks).padStart(4)}` +
          `  ceil=${budget.ceiling}  tbl=${tableRows} rows=${resultRows} scan=${scanTotal} sel=${sel}` +
          `  p50=${result.latency.p50Ms}ms p95=${result.latency.p95Ms}ms p99=${result.latency.p99Ms}ms`,
        );
        for (const f of assertionFailures) console.error(`        assertion: ${f}`);
        for (const f of scanRowViolations) console.error(`        scan-rows: ${f}`);
      }

      records.push({
        id: budget.id,
        outcome: ok ? "pass" : isVacuous && PROFILE === "minority" ? "unmeasured" : "fail",
        ceiling: budget.ceiling,
        tenantRows: tableRows,
        resultRows,
        blocks: run1.totalBlocks,
        warmBlocks: result.warmBlocks,
        latency: result.latency,
        planning: result.planningMs,
        coldMs: result.coldMs,
        assertionFailures,
        scanRowViolations,
        vacuous: isVacuous,
      });

      if (isVacuous) {
        const detail =
          `${budget.id}: query returned 0 rows — the budget measures an empty result set, ` +
          `so its ceiling and plan assertions cannot fail (vacuous budget)`;
        vacuous.push(detail);
        if (SELF_TEST) {
          if (budget.id === "self-test-vacuous") breaches.push(detail);
          else unusable.push(detail);
        } else if (PROFILE === "minority") unmeasured.push(detail);
        else breaches.push(detail);
      }

      if (overCeiling)
        breaches.push(`${budget.id}: ${totalBlocks} blocks > ceiling ${budget.ceiling}`);
      else if (SELF_TEST && run1.totalBlocks === 0 && budget.id !== "self-test-vacuous")
        unusable.push(`${budget.id}: run1.totalBlocks=0 — budget measured nothing`);
      for (const f of assertionFailures) breaches.push(f);
      for (const f of scanRowViolations) breaches.push(f);
    }

    if (SELF_TEST) {
      if (unusable.length > 0) {
        console.error(
          "SELF-TEST INCONCLUSIVE: one or more breach fixtures were unusable (skipped or measured nothing).",
        );
        for (const u of unusable) console.error(`  UNUSABLE: ${u}`);
        process.exitCode = 1;
        return;
      }
      const EXPECTED_BREACH_IDS = new Set([
        "self-test-ceiling",
        "self-test-assertion",
        "self-test-scan-rows",
        "self-test-seed-floor",
        "self-test-vacuous",
        "self-test-hashed-subplan",
      ]);
      const breachedIds = new Set(
        breaches.map((b) => b.split(":")[0].trim()),
      );
      const missing = [...EXPECTED_BREACH_IDS].filter((id) => !breachedIds.has(id));
      if (missing.length === 0) {
        console.log("SELF-TEST PASS: all 6 breach types detected — ceiling, plan-assertion, scan-rows, seed-floor, vacuous-result, hashed-subplan");
        process.exitCode = 0;
      } else {
        console.error(
          `SELF-TEST FAIL: ${missing.length} breach type(s) not detected — guard cannot fail for: ${missing.join(", ")}`,
        );
        for (const b of breaches) console.error(`  BREACH: ${b}`);
        process.exitCode = 1;
      }
      return;
    }

    const declared = budgets.length;
    // A vacuous budget ran, but over an empty result set: the number it produced is not a
    // measurement of the read it claims to guard, so it does not count toward coverage.
    // A seed-too-small budget did not run at all — `runBudget` returns before the EXPLAIN
    // loop — so counting it as measured inflates coverage with budgets that measured nothing.
    // On the reference profile it lands as outcome "fail", which is why it was being counted.
    const belowSeedFloor = records.filter((r) => r.reason === "seed-too-small").length;
    const measured = records.filter(
      (r) =>
        (r.outcome === "pass" || r.outcome === "fail") &&
        r.vacuous !== true &&
        r.reason !== "seed-too-small",
    ).length;
    const notMeasured = declared - measured;
    const pct = declared > 0 ? ((measured / declared) * 100).toFixed(1) : "0.0";

    console.log(
      `\n--- Tally: ${passed} PASS / ${breaches.length} FAIL / ${unmeasured.length} UNMEASURED` +
      ` / ${excluded} EXCL / ${skipped} SKIP ---`,
    );
    console.log(
      `Coverage: ${measured}/${declared} declared read-cost budgets produced a non-empty measurement` +
      ` on tenant ${ORG} (${pct}%), profile=${PROFILE}, samples=${SAMPLES}.` +
      ` ${notMeasured} unmeasured (${vacuous.length} vacuous, ${belowSeedFloor} below seed floor,` +
      ` ${skipped} no fixture, ${excluded} excluded) and therefore unenforced.`,
    );
    if (excluded > 0)
      console.log(`${excluded} budget(s) excluded by declaration — an excluded budget proves nothing.`);
    if (skipped > 0)
      console.log(`${skipped} budget(s) skipped (no fixture data — seed the relevant tables).`);
    if (vacuous.length > 0)
      console.log(`${vacuous.length} budget(s) returned 0 rows (vacuous — measured an empty result set).`);

    if (JSON_OUT) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        JSON_OUT,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            role: ROLE_PROVENANCE,
            tenant: ORG,
            profile: PROFILE,
            samples: SAMPLES,
            declared,
            measured,
            passed,
            breaches: breaches.length,
            unmeasured: unmeasured.length,
            excluded,
            skipped,
            budgets: records,
          },
          null,
          2,
        ) + "\n",
      );
      console.log(`Wrote ${JSON_OUT}`);
    }

    if (breaches.length > 0) {
      console.error(`\n${breaches.length} breach(es):`);
      for (const b of breaches) console.error(`  FAIL: ${b}`);
      console.error(`STATUS: FAIL — ${measured}/${declared} measured, ${breaches.length} over ceiling or vacuous.`);
      process.exitCode = 1;
      return;
    }

    if (notMeasured > 0) {
      console.log(
        `STATUS: PARTIAL — ${measured}/${declared} budgets measured and within ceiling;` +
        ` ${notMeasured} unmeasured, so this run does not prove they are within budget.`,
      );
      process.exitCode = STRICT ? 2 : 0;
      return;
    }

    console.log(`STATUS: OK — all ${declared}/${declared} declared budgets measured and within ceiling.`);
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
