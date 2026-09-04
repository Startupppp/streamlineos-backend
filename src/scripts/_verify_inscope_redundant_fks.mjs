/**
 * _verify_inscope_redundant_fks.mjs
 *
 * Verifies that no in-scope (non-CRM, non-Inventory) table carries a
 * redundant single-column FK after migration 1006 ran.
 *
 * Usage:
 *   DATABASE_URL=<owner-url> node src/scripts/_verify_inscope_redundant_fks.mjs
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL must be set"); process.exit(2); }
const sql = postgres(url, { ssl: "require", prepare: false });

// CRM tables (from backend/src/db/schema/crm/)
const CRM_TABLES = new Set([
  "assignment_rule_state","autonomy_settings","client_account_activities","client_accounts",
  "client_health_scores","client_onboarding_items","client_onboarding_templates",
  "client_opportunities","clients","contacts","crm_activities","crm_automation_actions",
  "crm_automation_events","crm_automation_rules","crm_automation_runs",
  "crm_blueprint_transitions","crm_blueprints","crm_campaigns","crm_companies",
  "crm_contact_channel_consent","crm_contact_consent_events","crm_contact_roles",
  "crm_deals","crm_email_templates","crm_lead_touchpoints","crm_monthly_metrics",
  "crm_options","crm_organizations","crm_people","crm_pipeline_stages","crm_pipelines",
  "crm_pricebook_entries","crm_pricebooks","crm_products","crm_quote_settings",
  "crm_quote_templates","crm_sequence_enrollments","crm_sequence_steps","crm_sequences",
  "crm_sla_policies","crm_support_tickets","crm_team_performance","crm_ui_metadata",
  "crm_validation_rules","csat_responses","csat_surveys","health_score_config",
  "invoice_items","invoices","lead_activities","lead_assignment_rules","lead_emails",
  "lead_import_batches","lead_notes","lead_scoring_rules","lead_tasks","leads",
  "nps_responses","nps_surveys","payments","playbook_entries","purchase_bill_items",
  "purchase_bills","quote_line_items","quotes","deals","deal_activities","deal_approvals",
  "deal_meetings","deal_meeting_attendees","commissions","incentives",
  // additional CRM tables that don't have explicit pgTable name strings
  "commission_rules","deal_approval_rules","deal_stage_transitions",
  "activities","activity_participants","autonomy_holds","autonomy_corrections",
  "autonomy_decisions","autonomy_shadow_scores","autonomy_switches","crm_connector_records",
  "crm_connector_syncs","crm_deal_competitors","crm_deal_stakeholders",
  "crm_forecast_snapshots","crm_import_rows","crm_imports","crm_mailbox_sync",
  "data_quality_findings","data_quality_health_snapshots","data_quality_resolutions",
  "inbound_events","incentive_config","issue_records","issue_stage_transitions",
  "sales_quotas","task_sequence_steps","vendor_payments","web_lead_forms",
  "crm_sla_breach_log","crm_suppression_hashes",
]);

const rows = await sql`
WITH composite_fks AS (
  SELECT
    con.conname                                              AS fk_name,
    src.relname                                              AS child_table,
    tgt.relname                                              AS parent_table,
    array_agg(a.attname ORDER BY u.pos) FILTER (WHERE a.atttypid IS NOT NULL) AS child_cols
  FROM pg_constraint con
  JOIN pg_class    src ON src.oid = con.conrelid
  JOIN pg_class    tgt ON tgt.oid = con.confrelid
  JOIN pg_namespace ns ON ns.oid = src.relnamespace
  JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(attnum, pos) ON TRUE
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.attnum
  WHERE con.contype = 'f'
    AND ns.nspname = 'public'
    AND array_length(con.conkey, 1) > 1
    AND EXISTS (
      SELECT 1
        FROM unnest(con.conkey) AS ck(attnum2)
        JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = ck.attnum2
       WHERE ca.attname = 'org_id'
    )
  GROUP BY con.conname, src.relname, tgt.relname
),
single_col_fks AS (
  SELECT
    con.conname    AS fk_name,
    src.relname    AS child_table,
    tgt.relname    AS parent_table,
    a.attname      AS child_col
  FROM pg_constraint con
  JOIN pg_class    src ON src.oid = con.conrelid
  JOIN pg_class    tgt ON tgt.oid = con.confrelid
  JOIN pg_namespace ns ON ns.oid = src.relnamespace
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
  WHERE con.contype = 'f'
    AND ns.nspname = 'public'
    AND array_length(con.conkey, 1) = 1
    AND a.attname <> 'org_id'
)
SELECT
  c.child_table,
  c.parent_table,
  c.fk_name       AS composite_fk_name,
  s.fk_name       AS single_fk_name,
  s.child_col     AS single_child_col
FROM composite_fks c
JOIN single_col_fks s
  ON s.child_table  = c.child_table
 AND s.parent_table = c.parent_table
 AND s.child_col    = ANY (c.child_cols)
ORDER BY c.child_table, c.parent_table
`;

// Filter out CRM and Inventory
const inScope = rows.filter(r =>
  !CRM_TABLES.has(r.child_table) &&
  !r.child_table.startsWith("inv_")
);

console.log(`Total redundant pairs at HEAD:      ${rows.length}`);
console.log(`Pairs in CRM or Inventory (excluded): ${rows.length - inScope.length}`);
console.log(`Pairs in release-scoped modules:    ${inScope.length}`);

if (inScope.length === 0) {
  console.log("\nRESULT: ZERO in-scope redundant single-column FK pairs remain.");
  console.log("In-scope modules are clean. C053 and C060 in-scope portion: SATISFIED.");
} else {
  console.log("\nIn-scope redundant pairs found:");
  for (const r of inScope) {
    console.log(`  ${r.child_table} -> ${r.parent_table}: SINGLE=${r.single_fk_name} (col: ${r.single_child_col})`);
  }
  console.log("\nRESULT: STILL HAS IN-SCOPE REDUNDANT FKs. C053/C060 remain open for in-scope.");
}

await sql.end();
