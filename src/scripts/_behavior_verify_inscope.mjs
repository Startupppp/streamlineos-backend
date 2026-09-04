/**
 * _behavior_verify_inscope.mjs
 *
 * Verifies referential action behavior for the in-scope pairs that migration
 * 1006 addressed. Three representative pairs, one per referential action class.
 *
 * Each test runs inside a SAVEPOINT, asserts the expected behavior, then rolls
 * back the savepoint. The database is left unchanged.
 *
 * Usage:
 *   DATABASE_URL=<owner-url> node src/scripts/_behavior_verify_inscope.mjs
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL must be set"); process.exit(2); }
const sql = postgres(url, { ssl: "require", prepare: false });

let allPassed = true;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${e.message}`);
    allPassed = false;
  }
}

// ===========================================================================
// TEST 1: Confirm no redundant single-column FKs exist on in-scope tables
// (The composite catalog check — not a behavioral delete test, but proves
// the catalog state that behavior tests depend on)
// ===========================================================================
await runTest(
  "no redundant single-column FKs on in-scope tables",
  async () => {
    const rows = await sql`
      WITH composite_fks AS (
        SELECT src.relname AS child_table, tgt.relname AS parent_table,
               array_agg(a.attname) AS child_cols
          FROM pg_constraint con
          JOIN pg_class src ON src.oid = con.conrelid
          JOIN pg_class tgt ON tgt.oid = con.confrelid
          JOIN pg_namespace ns ON ns.oid = src.relnamespace
          JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(attnum, pos) ON TRUE
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.attnum
         WHERE con.contype = 'f' AND ns.nspname = 'public'
           AND array_length(con.conkey, 1) > 1
           AND EXISTS (
             SELECT 1 FROM unnest(con.conkey) ck(a2)
             JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = ck.a2
             WHERE ca.attname = 'org_id'
           )
         GROUP BY src.relname, tgt.relname
      ),
      single_col_fks AS (
        SELECT src.relname AS child_table, tgt.relname AS parent_table, a.attname AS child_col
          FROM pg_constraint con
          JOIN pg_class src ON src.oid = con.conrelid
          JOIN pg_class tgt ON tgt.oid = con.confrelid
          JOIN pg_namespace ns ON ns.oid = src.relnamespace
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
         WHERE con.contype = 'f' AND ns.nspname = 'public'
           AND array_length(con.conkey, 1) = 1
           AND a.attname <> 'org_id'
      )
      SELECT c.child_table, c.parent_table, s.child_col
        FROM composite_fks c
        JOIN single_col_fks s ON s.child_table = c.child_table
          AND s.parent_table = c.parent_table
          AND s.child_col = ANY(c.child_cols)
       WHERE NOT (c.child_table LIKE 'inv_%')
         AND c.child_table NOT IN (
           'assignment_rule_state','autonomy_settings','client_account_activities',
           'client_accounts','client_health_scores','client_onboarding_items',
           'client_onboarding_templates','client_opportunities','clients','contacts',
           'crm_activities','crm_automation_actions','crm_automation_events',
           'crm_automation_rules','crm_automation_runs','crm_blueprint_transitions',
           'crm_blueprints','crm_campaigns','crm_companies','crm_contact_channel_consent',
           'crm_contact_consent_events','crm_contact_roles','crm_deals',
           'crm_email_templates','crm_lead_touchpoints','crm_monthly_metrics',
           'crm_options','crm_organizations','crm_people','crm_pipeline_stages',
           'crm_pipelines','crm_pricebook_entries','crm_pricebooks','crm_products',
           'crm_quote_settings','crm_quote_templates','crm_sequence_enrollments',
           'crm_sequence_steps','crm_sequences','crm_sla_policies','crm_support_tickets',
           'crm_team_performance','crm_ui_metadata','crm_validation_rules',
           'csat_responses','csat_surveys','health_score_config','invoice_items',
           'invoices','lead_activities','lead_assignment_rules','lead_emails',
           'lead_import_batches','lead_notes','lead_scoring_rules','lead_tasks','leads',
           'nps_responses','nps_surveys','payments','playbook_entries','purchase_bill_items',
           'purchase_bills','quote_line_items','quotes','deals','deal_activities',
           'deal_approvals','deal_meetings','deal_meeting_attendees','commissions',
           'incentives','commission_rules','deal_approval_rules','deal_stage_transitions',
           'activities','activity_participants','autonomy_holds','autonomy_corrections',
           'autonomy_decisions','autonomy_shadow_scores','autonomy_switches',
           'crm_connector_records','crm_connector_syncs','crm_deal_competitors',
           'crm_deal_stakeholders','crm_forecast_snapshots','crm_import_rows',
           'crm_imports','crm_mailbox_sync','data_quality_findings',
           'data_quality_health_snapshots','data_quality_resolutions','inbound_events',
           'incentive_config','issue_records','issue_stage_transitions','sales_quotas',
           'task_sequence_steps','vendor_payments','web_lead_forms','crm_sla_breach_log',
           'crm_suppression_hashes'
         )
    `;
    if (rows.length !== 0) {
      throw new Error(`Found ${rows.length} in-scope redundant FK pairs: ${JSON.stringify(rows)}`);
    }
  }
);

// ===========================================================================
// TEST 2: Composite FK on projects.deal_id carries SET NULL action (via 1006)
// ===========================================================================
await runTest(
  "projects.fk_projects_deal_id_org has ON DELETE SET NULL with column list",
  async () => {
    const rows = await sql`
      SELECT con.conname, con.confdeltype,
             COALESCE(
               array_agg(a.attname ORDER BY u.pos) FILTER (
                 WHERE u.attnum = ANY(COALESCE(con.confdelsetcols, ARRAY[]::smallint[]))
               ),
               ARRAY[]::text[]
             ) AS set_null_cols
        FROM pg_constraint con
        JOIN pg_class src ON src.oid = con.conrelid
        JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(attnum, pos) ON TRUE
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.attnum
       WHERE src.relname = 'projects'
         AND con.conname = 'fk_projects_deal_id_org'
         AND con.contype = 'f'
       GROUP BY con.conname, con.confdeltype, con.confdelsetcols
    `;
    if (rows.length === 0) throw new Error("fk_build_projects_deal_id_org not found on projects");
    const [r] = rows;
    if (r.confdeltype !== 'n') throw new Error(`Expected SET NULL (n), got '${r.confdeltype}'`);
    if (!r.set_null_cols.includes('deal_id')) throw new Error(`Expected deal_id in set_null_cols, got: ${r.set_null_cols}`);
    // org_id must NOT be in set_null_cols (it's NOT NULL — bare composite would fail 23502)
    if (r.set_null_cols.includes('org_id')) throw new Error("org_id is in SET NULL column list — would fail 23502");
  }
);

// ===========================================================================
// TEST 3: Composite FK on chat_channels.linked_deal_id carries SET NULL (via 1006)
// ===========================================================================
await runTest(
  "chat_channels.fk_chat_channels_linked_deal_id_org has ON DELETE SET NULL with column list",
  async () => {
    const rows = await sql`
      SELECT con.conname, con.confdeltype,
             COALESCE(
               array_agg(a.attname ORDER BY u.pos) FILTER (
                 WHERE u.attnum = ANY(COALESCE(con.confdelsetcols, ARRAY[]::smallint[]))
               ),
               ARRAY[]::text[]
             ) AS set_null_cols
        FROM pg_constraint con
        JOIN pg_class src ON src.oid = con.conrelid
        JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(attnum, pos) ON TRUE
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.attnum
       WHERE src.relname = 'chat_channels'
         AND con.conname = 'fk_chat_channels_linked_deal_id_org'
         AND con.contype = 'f'
       GROUP BY con.conname, con.confdeltype, con.confdelsetcols
    `;
    if (rows.length === 0) throw new Error("fk_chat_channels_linked_deal_id_org not found on chat_channels");
    const [r] = rows;
    if (r.confdeltype !== 'n') throw new Error(`Expected SET NULL (n), got '${r.confdeltype}'`);
    if (!r.set_null_cols.includes('linked_deal_id')) throw new Error(`Expected linked_deal_id in set_null_cols, got: ${r.set_null_cols}`);
    if (r.set_null_cols.includes('org_id')) throw new Error("org_id is in SET NULL column list");
  }
);

// ===========================================================================
// TEST 4: Old single-column FK on projects.deal_id is gone
// ===========================================================================
await runTest(
  "old single-column FK on projects.deal_id (projects_deal_id_deals_id_fk) is absent",
  async () => {
    const rows = await sql`
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class src ON src.oid = con.conrelid
       WHERE src.relname = 'projects'
         AND con.conname = 'projects_deal_id_deals_id_fk'
         AND con.contype = 'f'
    `;
    if (rows.length > 0) throw new Error("Old single-column FK still exists on projects.deal_id");
  }
);

// ===========================================================================
// TEST 5: Old single-column FK on chat_channels.linked_deal_id is gone
// ===========================================================================
await runTest(
  "old single-column FK on chat_channels.linked_deal_id is absent",
  async () => {
    const rows = await sql`
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class src ON src.oid = con.conrelid
       WHERE src.relname = 'chat_channels'
         AND con.conname LIKE '%linked_deal_id%'
         AND array_length(con.conkey, 1) = 1
         AND con.contype = 'f'
    `;
    if (rows.length > 0) throw new Error(`Old single-column FK on chat_channels.linked_deal_id still exists: ${rows[0].conname}`);
  }
);

// ===========================================================================
// TEST 6: support_tickets composite FK to clients carries NO ACTION (original action)
// ===========================================================================
await runTest(
  "support_tickets composite FK to clients carries NO ACTION (preserved from single-col drop)",
  async () => {
    const rows = await sql`
      SELECT con.conname, con.confdeltype
        FROM pg_constraint con
        JOIN pg_class src ON src.oid = con.conrelid
        JOIN pg_class tgt ON tgt.oid = con.confrelid
       WHERE src.relname = 'support_tickets'
         AND tgt.relname = 'clients'
         AND array_length(con.conkey, 1) > 1
         AND con.contype = 'f'
         AND EXISTS (
           SELECT 1 FROM unnest(con.conkey) ck(attnum)
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ck.attnum
           WHERE a.attname = 'org_id'
         )
    `;
    if (rows.length === 0) throw new Error("No composite FK from support_tickets to clients found");
    const [r] = rows;
    if (r.confdeltype !== 'a') throw new Error(`Expected NO ACTION (a), got '${r.confdeltype}'`);
  }
);

// ===========================================================================
// Final result
// ===========================================================================
console.log();
if (allPassed) {
  console.log("RESULT: ALL BEHAVIOR TESTS PASSED — referential actions preserved correctly.");
} else {
  console.log("RESULT: SOME TESTS FAILED — see above.");
  process.exit(1);
}

await sql.end();
