/**
 * Verify all six rollback scripts against the live database.
 *
 * Each rollback is executed inside a transaction that is ALWAYS rolled back,
 * so nothing persists. The script asserts the expected schema state INSIDE
 * the transaction (after the rollback SQL runs but before the discard), then
 * throws an intentional error to discard everything.
 *
 * Usage:
 *   node backend/migrations/rollback/verify-rollbacks.mjs
 *
 * Requires:
 *   - DATABASE_URL in backend/.env  (or the environment)
 *   - postgres package (already in backend/package.json)
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { config } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Load backend/.env (two levels up from rollback/)
config({ path: join(__dirname, '../../.env') });

const require = createRequire(import.meta.url);
const postgres = require('postgres');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not found in environment');
  process.exit(1);
}

const sql = postgres(url, { prepare: false, max: 1, ssl: 'require' });

function readDown(name) {
  return readFileSync(join(__dirname, `${name}.down.sql`), 'utf8');
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function indexExists(tx, indexName) {
  const rows = await tx`
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = ${indexName}
  `;
  return rows.length > 0;
}

async function columnExists(tx, table, column) {
  const rows = await tx`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = ${table}
      AND column_name  = ${column}
  `;
  return rows.length > 0;
}

async function columnDefault(tx, table, column) {
  const rows = await tx`
    SELECT column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = ${table}
      AND column_name  = ${column}
  `;
  return rows[0]?.column_default ?? null;
}

async function columnDataType(tx, table, column) {
  const rows = await tx`
    SELECT udt_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = ${table}
      AND column_name  = ${column}
  `;
  return rows[0] ?? null;
}

async function tableExists(tx, table) {
  const rows = await tx`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${table}
  `;
  return rows.length > 0;
}

async function constraintExists(tx, table, constraintName) {
  const rows = await tx`
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema     = 'public'
      AND table_name       = ${table}
      AND constraint_name  = ${constraintName}
  `;
  return rows.length > 0;
}

async function typeExists(tx, typeName) {
  const rows = await tx`
    SELECT 1 FROM pg_type
    WHERE typname = ${typeName} AND typnamespace = 'public'::regnamespace
  `;
  return rows.length > 0;
}

// ─── migration verifiers ──────────────────────────────────────────────────────

async function verify0126(tx) {
  const observations = [];

  // idx_tickets_assignee should be RESTORED (it was dropped by 0126)
  const assigneeExists = await indexExists(tx, 'idx_tickets_assignee');
  observations.push(`idx_tickets_assignee recreated: ${assigneeExists}`);

  // The three indexes added by 0126 should be GONE
  const orgProjectOrder  = await indexExists(tx, 'idx_tickets_org_project_order');
  const orgAssigneeStatus = await indexExists(tx, 'idx_tickets_org_assignee_status');
  const orgAssigneeDue   = await indexExists(tx, 'idx_tickets_org_assignee_due_open');
  observations.push(`idx_tickets_org_project_order dropped: ${!orgProjectOrder}`);
  observations.push(`idx_tickets_org_assignee_status dropped: ${!orgAssigneeStatus}`);
  observations.push(`idx_tickets_org_assignee_due_open dropped: ${!orgAssigneeDue}`);

  const ok = assigneeExists && !orgProjectOrder && !orgAssigneeStatus && !orgAssigneeDue;
  return { ok, observations };
}

async function verify0127(tx) {
  const observations = [];

  const def = await columnDefault(tx, 'roadmap_items', 'is_public');
  observations.push(`roadmap_items.is_public DEFAULT: ${def}`);

  // Default should be 'true' (Postgres stores it as "true")
  const ok = def !== null && def.includes('true');
  return { ok, observations };
}

async function verify0137(tx) {
  const observations = [];

  const roadmapCol  = await columnExists(tx, 'roadmap_votes',  'voter_ip_hash');
  const feedbackCol = await columnExists(tx, 'feedback_votes', 'voter_ip_hash');
  const roadmapIdx  = await indexExists(tx, 'uniq_roadmap_votes_item_ip');
  const feedbackIdx = await indexExists(tx, 'uniq_feedback_votes_post_ip');

  observations.push(`roadmap_votes.voter_ip_hash dropped: ${!roadmapCol}`);
  observations.push(`feedback_votes.voter_ip_hash dropped: ${!feedbackCol}`);
  observations.push(`uniq_roadmap_votes_item_ip dropped: ${!roadmapIdx}`);
  observations.push(`uniq_feedback_votes_post_ip dropped: ${!feedbackIdx}`);

  const ok = !roadmapCol && !feedbackCol && !roadmapIdx && !feedbackIdx;
  return { ok, observations };
}

async function verify0142(tx) {
  const observations = [];

  const orderExists = await columnExists(tx, 'tickets', 'order');
  const rankExists  = await columnExists(tx, 'tickets', 'rank');
  const newIdx      = await indexExists(tx, 'idx_tickets_org_project_rank');
  const oldIdx      = await indexExists(tx, 'idx_tickets_org_project_order');

  observations.push(`tickets."order" recreated: ${orderExists}`);
  observations.push(`tickets.rank dropped: ${!rankExists}`);
  observations.push(`idx_tickets_org_project_rank dropped: ${!newIdx}`);
  observations.push(`idx_tickets_org_project_order recreated: ${oldIdx}`);

  // Spot-check a few derived values (sample up to 5 rows)
  const sample = await tx`
    SELECT "order", ROUND(("order" + 1) * 1000) AS expected_rank
    FROM tickets LIMIT 5
  `;
  observations.push(`Sample order values (first 5 rows): ${JSON.stringify(sample.map(r => r.order))}`);

  const ok = orderExists && !rankExists && !newIdx && oldIdx;
  return { ok, observations };
}

async function verify0143(tx) {
  const observations = [];

  // Check that columns reverted to text data_type
  const checks = [
    { table: 'timesheets',         column: 'status' },
    { table: 'timesheets',         column: 'payroll_status' },
    { table: 'timesheets',         column: 'billing_type' },
    { table: 'timesheets',         column: 'invoicing_status' },
    { table: 'timesheets',         column: 'rate_source' },
    { table: 'timesheets',         column: 'source' },
    { table: 'timesheet_periods',  column: 'status' },
    { table: 'timer_sessions',     column: 'status' },
    { table: 'timer_sessions',     column: 'source' },
    { table: 'timesheet_budgets',  column: 'budget_type' },
    { table: 'timesheet_budgets',  column: 'status' },
    { table: 'timesheet_exports',  column: 'export_type' },
    { table: 'timesheet_exports',  column: 'status' },
    { table: 'timesheet_exports',  column: 'format' },
    { table: 'timesheet_settings', column: 'rounding_rule' },
    { table: 'timesheet_settings', column: 'approval_mode' },
    { table: 'timesheet_settings', column: 'pay_period' },
    { table: 'timesheet_rates',    column: 'billing_type' },
  ];

  let allText = true;
  for (const { table, column } of checks) {
    const info = await columnDataType(tx, table, column);
    const isText = info?.data_type === 'text' || info?.udt_name === 'text';
    observations.push(`${table}.${column} → ${info?.data_type ?? 'MISSING'}: text=${isText}`);
    if (!isText) allText = false;
  }

  // Check all 17 enum types are dropped
  const enumNames = [
    'timesheet_entry_status', 'timesheet_payroll_status', 'timesheet_billing_type',
    'timesheet_invoicing_status', 'timesheet_rate_source', 'timesheet_entry_source',
    'timesheet_period_status', 'timer_session_status', 'timer_session_source',
    'timesheet_budget_type', 'timesheet_budget_status', 'timesheet_export_type',
    'timesheet_export_status', 'timesheet_export_format', 'timesheet_rounding_rule',
    'timesheet_approval_mode', 'timesheet_pay_period',
  ];
  let allDropped = true;
  for (const typeName of enumNames) {
    const exists = await typeExists(tx, typeName);
    observations.push(`type ${typeName} dropped: ${!exists}`);
    if (exists) allDropped = false;
  }

  const ok = allText && allDropped;
  return { ok, observations };
}

async function verify0146(tx) {
  const observations = [];

  // FK on tickets should be gone
  const fkExists = await constraintExists(tx, 'tickets', 'fk_tickets_status');
  observations.push(`fk_tickets_status dropped: ${!fkExists}`);

  // Unique constraint on project_statuses should be gone
  const uqExists = await constraintExists(tx, 'project_statuses', 'uniq_project_statuses_org_project_name');
  observations.push(`uniq_project_statuses_org_project_name dropped: ${!uqExists}`);

  // project_statuses.type should be text again
  const typeInfo = await columnDataType(tx, 'project_statuses', 'type');
  observations.push(`project_statuses.type data_type: ${typeInfo?.data_type} (want text)`);

  // custom_states should exist again
  const csExists = await tableExists(tx, 'custom_states');
  observations.push(`custom_states recreated: ${csExists}`);

  // tickets.state_id should exist
  const stateIdExists = await columnExists(tx, 'tickets', 'state_id');
  observations.push(`tickets.state_id recreated: ${stateIdExists}`);

  // tickets.state_id FK constraint should exist
  const stateIdFk = await constraintExists(tx, 'tickets', 'tickets_state_id_custom_states_id_fk');
  observations.push(`tickets_state_id_custom_states_id_fk recreated: ${stateIdFk}`);

  const ok = !fkExists && !uqExists
    && (typeInfo?.data_type === 'text' || typeInfo?.udt_name === 'text')
    && csExists && stateIdExists && stateIdFk;
  return { ok, observations };
}

// ─── runner ───────────────────────────────────────────────────────────────────

const MIGRATIONS = [
  {
    name: '0126_build_ticket_hot_path_indexes',
    verify: verify0126,
  },
  {
    name: '0127_roadmap_items_private_by_default',
    verify: verify0127,
  },
  {
    name: '0137_add_voter_ip_hash',
    verify: verify0137,
  },
  {
    name: '0142_tickets_fractional_rank',
    verify: verify0142,
  },
  {
    name: '0143_timesheets_text_to_enums',
    verify: verify0143,
  },
  {
    name: '0146_status_model_single_table',
    verify: verify0146,
  },
];

const INTENTIONAL_ROLLBACK = 'INTENTIONAL_ROLLBACK';

let allPassed = true;

for (const { name, verify } of MIGRATIONS) {
  process.stdout.write(`\n${'─'.repeat(70)}\n`);
  process.stdout.write(`▶ ${name}\n`);

  const downSql = readDown(name);
  let result;

  try {
    await sql.begin(async tx => {
      // Execute the rollback SQL. Split on --> statement-breakpoint and run
      // each statement individually so postgres() doesn't reject multi-statement
      // strings in simple-query mode.
      const statements = downSql
        .split(/--> statement-breakpoint/)
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--') || s.includes(' '));

      // Run through unsafe() to handle multi-statement blocks (DO $$, etc.)
      // and DDL that the tagged-template API won't parse.
      for (const stmt of statements) {
        const trimmed = stmt.trim();
        if (!trimmed || trimmed.replace(/--[^\n]*/g, '').trim() === '') continue;
        await tx.unsafe(trimmed);
      }

      // Assert the expected schema state inside the transaction.
      result = await verify(tx);

      // Always discard — the throw exits sql.begin, triggering ROLLBACK.
      throw new Error(INTENTIONAL_ROLLBACK);
    });
  } catch (err) {
    if (!err.message?.includes(INTENTIONAL_ROLLBACK)) {
      console.error(`  ✗ UNEXPECTED ERROR: ${err.message}`);
      allPassed = false;
      continue;
    }
  }

  // Report what the assertions saw.
  for (const obs of result.observations) {
    const icon = obs.toLowerCase().includes(': false') ? '  ✗' : '  ✓';
    console.log(`${icon} ${obs}`);
  }

  if (result.ok) {
    console.log(`  → PASS (transaction discarded — no schema changes persisted)`);
  } else {
    console.log(`  → FAIL`);
    allPassed = false;
  }
}

process.stdout.write(`\n${'═'.repeat(70)}\n`);
console.log(allPassed ? 'ALL ROLLBACKS VERIFIED' : 'ONE OR MORE ROLLBACKS FAILED');

await sql.end();
process.exit(allPassed ? 0 : 1);
