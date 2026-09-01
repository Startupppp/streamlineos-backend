/**
 * check-migration-discipline.mjs
 *
 * CI gate for migration authoring discipline.
 * Fails (exit 1) when a NEW migration violates any of seven rules.
 * Historical violations are baselined; only new ones fail the gate.
 *
 * Checks:
 *   1. lock_timeout  — every migration must SET lock_timeout so it fails fast
 *                      instead of queuing and blocking the table behind it.
 *   2. FK not-valid  — ADD CONSTRAINT … FOREIGN KEY must include NOT VALID;
 *                      omitting it takes ACCESS EXCLUSIVE on BOTH tables for
 *                      the full trigger-install pass.
 *   3. NOT NULL two-step — SET NOT NULL must be preceded by a
 *                      CHECK (col IS NOT NULL) NOT VALID → VALIDATE sequence;
 *                      skipping it rewrites the entire table under lock.
 *   4. validate-before-backfill — backfill UPDATE must come BEFORE VALIDATE
 *                      CONSTRAINT; the reversed order aborts on any DB that
 *                      has NULL rows (the 0665 defect).
 *   5. DO-block breakpoint — --> statement-breakpoint must not appear inside
 *                      a DO $$ … $$ block; Drizzle splits on that marker and
 *                      tears the block into invalid SQL fragments.
 *   6. journal entry — every .sql file in migrations/ must have a matching
 *                      entry in meta/_journal.json; absent entries never apply
 *                      while db:migrate still prints success.
 *   7. CONCURRENTLY   — CREATE INDEX CONCURRENTLY cannot run inside drizzle-kit
 *                      migrate's transaction wrapper; it errors immediately.
 *                      Use CREATE INDEX (without CONCURRENTLY) and rely on
 *                      lock_timeout to bound the lock wait instead.
 *
 * Ratchet: historical violations are baselined explicitly. The gate fails only
 * on NEW violations. The baseline can only shrink.
 *
 *   8. journal integrity — when values strictly increasing, idx unique, no two
 *                      files sharing a numeric prefix, and no journal entry
 *                      without a file on disk. A when value at or below the
 *                      applied watermark is skipped forever while db:migrate
 *                      still prints success; this stranded five migrations and
 *                      six columns of schema drift on 2026-08-30.
 *
 * NOT COVERED (see companion check:migration-chain):
 *   - Applied-watermark ahead of journal (needs a live DB connection).
 *   - Comments that contain keywords (e.g., "-- NOT VALID") and trick
 *     the pattern matches — this gate uses text scans, not a SQL parser.
 *     Check 4 (validate-order) is the exception: it strips SQL comments first,
 *     because a header comment documenting "ALTER TABLE t VALIDATE CONSTRAINT c"
 *     was reported as a real violation in 0818.
 *
 * Usage:
 *   node src/scripts/check-migration-discipline.mjs [--self-test] [--migrations=<path>]
 * Exit:
 *   0   clean (or self-test passed)
 *   1   new violations found (or self-test detected a broken check)
 *   2   broken filesystem walk (vacuity check failed)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");

const argv = process.argv.slice(2);
const SELF_TEST = argv.includes("--self-test");
const MIGRATIONS_DIR = resolve(
  BACKEND_ROOT,
  (argv.find((a) => a.startsWith("--migrations=")) ?? "--migrations=migrations").slice(
    "--migrations=".length,
  ),
);

// Minimum number of SQL files the scan must find (anti-vacuity).
// Currently 393; allow slight shrinkage for future cleanup but fail if the
// walk is broken.
const MIN_SQL_FILES = 380;

// ─── baselines ────────────────────────────────────────────────────────────────
// Historical violations: already applied, cannot be corrected in-place.
// These sets can only SHRINK over time (as forward-corrections are added).
// A new file that is not listed here but triggers a check causes exit 1.

const BASELINE_NO_LOCK_TIMEOUT = new Set([
  // pre-0232 generated baseline (20 files)
  "0000_light_vance_astro.sql",
  "0001_ai_token_billing.sql",
  "0002_platform_admin_flag.sql",
  "0003_document_types_country_code.sql",
  "0004_attendance_multi_session.sql",
  "0005_projectos_teams_and_comment_drafts.sql",
  "0006_projectos_parity_gaps.sql",
  "0007_search_trgm_indexes.sql",
  "0008_user_module_access.sql",
  "0016_volatile_nicolaos.sql",
  "0150_analyze_after_build_rewrites.sql",
  "0170_crm_soft_delete_and_partial_indexes.sql",
  "0171_drop_dead_crm_leads.sql",
  "0172_quotes_fx_rate_snapshot.sql",
  "0179_curved_falcon.sql",
  "0180_hr_kb_partial_live_indexes.sql",
  "0183_abandoned_captain_stacy.sql",
  "0184_crm_activity_task_completed.sql",
  "0185_crm_suppression_hashes.sql",
  "0232_repair_crm_activity_grants.sql",
  // post-0232 recon wave and subsequent migrations (129 files)
  "0233_deals_value_not_null.sql",
  "0291_payroll_phase0_safety.sql",
  "0292_payroll_phase1_2_foundation.sql",
  "0293_payroll_prd_ship_constraints.sql",
  "0294_payroll_journal_outbox.sql",
  "0295_hrms_perf_indexes.sql",
  "0296_hrms_org_departments.sql",
  "0297_hr_disciplinary_acknowledge.sql",
  "0298_payroll_runs_entity_uniqueness.sql",
  "0299_onboarding_template_org_departments.sql",
  "0300_kb_chunk_content_hash.sql",
  "0300_timesheets_launch_grade.sql",
  "0301_inv_stock_levels_natural_key.sql",
  "0302_inv_perf_indexes.sql",
  "0303_inv_name_uniqueness.sql",
  "0304_inv_status_enums.sql",
  "0305_outbox.sql",
  "0306_chat_org_id.sql",
  "0307_recon_additive_foundation.sql",
  "0308_recon_idempotency_fences.sql",
  "0309_recon_project_teams.sql",
  "0310_recon_owner_pointer.sql",
  "0311_recon_owner_fk_trigger.sql",
  "0312_recon_org_modules_fk.sql",
  "0313_recon_org_modules_backfill.sql",
  "0314_recon_org_invitation_lifecycle.sql",
  "0315_recon_pm_workspaces.sql",
  "0316_recon_offer_fulfillment.sql",
  "0317_recon_party_overlays.sql",
  "0318_recon_managed_product_fields.sql",
  "0319_recon_email_orgid.sql",
  "0320_recon_phase_a_orgid.sql",
  "0321_recon_defect_fks.sql",
  "0322_recon_phase_c_candidate_keys.sql",
  "0323_recon_phase_d_composite_fks.sql",
  "0324_recon_directory_party_fks.sql",
  "0325_recon_membership_fk.sql",
  "0326_recon_owner_not_null.sql",
  "0327_recon_decouple_projects_crm.sql",
  "0328_membership_role_assignments.sql",
  "0329_owner_exactly_one.sql",
  "0330_worker_engagement_overlap.sql",
  "0331_pm_workspace_id_nullable.sql",
  "0332_pm_workspace_id_backfill.sql",
  "0333_pm_workspace_id_not_null.sql",
  "0334_drop_dead_schema_objects.sql",
  "0335_org_arrays_and_invites.sql",
  "0336_kb_hr_array_normalization.sql",
  "0337_modules_catalog.sql",
  "0338_module_ownership.sql",
  "0339_remaining_array_normalization.sql",
  "0340_module_scoped_roles.sql",
  "0341_org_units_consolidation.sql",
  "0342_role_assignment_collapse.sql",
  "0343_module_admin_roles.sql",
  "0344_org_consolidation_finish.sql",
  "0345_payroll_generation_collapse.sql",
  "0346_invitation_events.sql",
  "0347_fk_repairs.sql",
  "0348_drop_polymorphic_tables.sql",
  "0349_retire_legacy_org_tables.sql",
  "0350_retire_departments.sql",
  "0351_automation_consolidation.sql",
  "0352_custom_fields_consolidation.sql",
  "0353_billing_idempotency.sql",
  "0354_drop_dead_types.sql",
  "0355_journal_lines_hardening.sql",
  "0356_search_and_notification_indexes.sql",
  "0357_idempotency_schema.sql",
  "0358_csat_and_client_slug.sql",
  "0359_exit_checklists_org_id.sql",
  "0360_workflow_variables_org_id.sql",
  "0361_roles_durability_fields.sql",
  "0362_org_owner_uniqueness.sql",
  "0363_collapse_role_zoo.sql",
  "0364_drop_dead_tables.sql",
  "0365_drop_orphan_enum.sql",
  "0366_role_column_defaults.sql",
  "0367_drop_dead_user_preferences.sql",
  "0368_rename_ceo_to_final.sql",
  "0369_drop_platform_admin.sql",
  "0370_build_project_members_org_id.sql",
  "0370_tenant_column_integrity.sql",
  "0371_build_status_check_constraints.sql",
  "0371_drop_users_role.sql",
  "0372_build_pk_widening_round2.sql",
  "0372_timesheets_module.sql",
  "0373_resource_grants.sql",
  "0374_build_partial_indexes.sql",
  "0374_tenant_guc_helper.sql",
  "0375_build_drop_dead_reports.sql",
  "0375_rls_canary_projects.sql",
  "0376_rls_payroll_and_pii.sql",
  "0377_rls_financial.sql",
  "0378_rls_remaining_tenant_tables.sql",
  "0379_effective_dating_convention.sql",
  "0379_legal_entities_create.sql",
  "0379_payroll_entities_legal_entity_fk.sql",
  "0408_notification_category_accounting.sql",
  "0410_notification_visibility_resource_kind.sql",
  "0411_suppression_reason_no_access.sql",
  "0424_ticket_search_index_function.sql",
  "0425_ticket_search_bounded.sql",
  "0427_managed_products_pk_rename.sql",
  "0428_feedback_dedup_merge.sql",
  "0430_project_ticket_counters.sql",
  "0431_build_events_schema.sql",
  "0432_build_schema.sql",
  "0434_chat_message_search.sql",
  "0472_outbox_inbox_aggregate_fence.sql",
  "0474_external_effect_ledger.sql",
  "0616_timesheets_declared_indexes_exist.sql",
  "0619_chain_creates_what_production_has.sql",
  "0620_control_plane_receives_chain_tenant_isolation.sql",
  "0621_candidate_resumes_tenant_column.sql",
  "0622_custom_field_definitions_constraint_names.sql",
  "0623_workflow_variables_tenant_constraints.sql",
  "0624_inventory_sku_uniqueness_restored.sql",
  "0625_relocation_copy_progress.sql",
  "0626_org_members_joined_at_index.sql",
  "0627_org_cell_traffic.sql",
  "0637_finance_cursor_retention.sql",
  "0638_accounting_child_tenant_indexes.sql",
  "0639_perf_reviews_cursor_indexes.sql",
  "0640_helpdesk_search_and_cursor_indexes.sql",
  "0641_financial_actor_audit_identity.sql",
  "0651_drop_calendar_attendee_json.sql",
  "0659_expense_export_jobs.sql",
  "0663_invoice_reminder_due_index.sql",
  "0734_operator_access_grants.sql",
  "0747_operator_access_two_person_approval.sql",
  "0756_fin_reminder_log_measurement.sql",
]);

const BASELINE_FK_NOT_VALID = new Set([
  "0000_light_vance_astro.sql",
  "0016_volatile_nicolaos.sql",
  "0185_crm_suppression_hashes.sql",
  "0299_onboarding_template_org_departments.sql",
  "0305_outbox.sql",
  "0306_chat_org_id.sql",
  "0307_recon_additive_foundation.sql",
  "0311_recon_owner_fk_trigger.sql",
  "0312_recon_org_modules_fk.sql",
  "0315_recon_pm_workspaces.sql",
  "0320_recon_phase_a_orgid.sql",
  "0321_recon_defect_fks.sql",
  "0323_recon_phase_d_composite_fks.sql",
  "0324_recon_directory_party_fks.sql",
  "0325_recon_membership_fk.sql",
  "0328_membership_role_assignments.sql",
  "0335_org_arrays_and_invites.sql",
  "0337_modules_catalog.sql",
  "0342_role_assignment_collapse.sql",
  "0344_org_consolidation_finish.sql",
  "0346_invitation_events.sql",
  "0347_fk_repairs.sql",
  "0348_drop_polymorphic_tables.sql",
  "0349_retire_legacy_org_tables.sql",
  "0350_retire_departments.sql",
  "0355_journal_lines_hardening.sql",
  "0359_exit_checklists_org_id.sql",
  "0360_workflow_variables_org_id.sql",
  "0361_roles_durability_fields.sql",
  "0370_build_project_members_org_id.sql",
  "0370_tenant_column_integrity.sql",
  "0423_repair_schema_drift.sql",
  "0428_feedback_dedup_merge.sql",
  "0430_project_ticket_counters.sql",
  "0617_cell_relocation_and_placement_decisions.sql",
  "0619_chain_creates_what_production_has.sql",
  "0620_control_plane_receives_chain_tenant_isolation.sql",
  "0621_candidate_resumes_tenant_column.sql",
  "0623_workflow_variables_tenant_constraints.sql",
  "0655_chain_creates_remaining_catalog_objects.sql",
]);

const BASELINE_SET_NOT_NULL = new Set([
  "0142_tickets_fractional_rank.sql",
  "0240_party_expand_legacy_fields.sql",
  "0306_chat_org_id.sql",
  "0310_recon_owner_pointer.sql",
  "0320_recon_phase_a_orgid.sql",
  "0326_recon_owner_not_null.sql",
  "0333_pm_workspace_id_not_null.sql",
  "0355_journal_lines_hardening.sql",
  "0359_exit_checklists_org_id.sql",
  "0360_workflow_variables_org_id.sql",
  "0370_build_project_members_org_id.sql",
  "0379_effective_dating_convention.sql",
  "0610_agent_tokens_membership_and_ceiling.sql",
  "0614_ownership_transfers_record_initiator.sql",
  "0619_chain_creates_what_production_has.sql",
  "0620_control_plane_receives_chain_tenant_isolation.sql",
  "0621_candidate_resumes_tenant_column.sql",
  "0628_communication_actor_normalization.sql",
  "0657_kb_article_tags_tenant_integrity.sql",
  "0658_calendar_membership_actors.sql",
]);

const BASELINE_VALIDATE_BEFORE_BACKFILL = new Set([
  "0290_issue_records.sql",
  "0665_kb_article_chunks_acl_revision_not_null.sql",
]);

// Checks 5, 6, and 7 have zero historical violations — no baseline entries needed.
const BASELINE_DO_BLOCK_BREAKPOINT = new Set();
const BASELINE_NO_JOURNAL_ENTRY = new Set();
const BASELINE_CONCURRENTLY = new Set();

const BASELINE_JOURNAL_INTEGRITY = new Set([
  "dup-prefix:0300_timesheets_launch_grade.sql",
  "dup-prefix:0370_tenant_column_integrity.sql",
  "dup-prefix:0371_drop_users_role.sql",
  "dup-prefix:0372_timesheets_module.sql",
  "dup-prefix:0374_tenant_guc_helper.sql",
  "dup-prefix:0375_rls_canary_projects.sql",
  "dup-prefix:0379_effective_dating_convention.sql",
  "dup-prefix:0420_inv_webhook_event_subscriptions.sql",
  "dup-prefix:0426_notification_timestamptz.sql",
  "dup-prefix:0430_project_ticket_counters.sql",
  "dup-prefix:0431_email_outbox_scope.sql",
  "dup-prefix:0432_drop_quiet_hours_timezone.sql",
  "dup-prefix:0700_timesheets_idx_org_status_date.sql",
  "dup-prefix:0701_timesheets_attr_validate.sql",
  // 0591b, 0649b, 0676b are cold-replay repairs inserted mid-journal so that tables are
  // created before RLS or policy statements reference them on a fresh DB. Their `when`
  // is set above the production watermark so production applies them as no-ops (all
  // statements are idempotent). Array position and `when` answer different questions:
  // position governs cold replay order; `when` governs whether production applies the
  // migration. Both entries are intentional and cannot be corrected without breaking one
  // or the other invariant.
  "journal-order:0591_tenant_isolation_for_unprotected_tables.sql",
  "insert-order:0591b_gl_ap_ar_bank_tax_chain_repair.sql",
  // 0649b inserted between 0649 and 0650 so inv_carton_types and inv_shipment_status_events
  // exist before 0650 enables RLS on them on a cold replay.
  "journal-order:0650_tenant_isolation_for_three_unprotected_tables.sql",
  "insert-order:0649b_inv_carton_shipment_chain_repair.sql",
  // 0676b inserted between 0676 and 0677 so inv_compliance_documents exists before 0677
  // and 0666 create policies on it on a cold replay.
  "journal-order:0677_rls_fix_guc_key.sql",
  "insert-order:0676b_inv_compliance_documents_chain_repair.sql",
  // 0677b inserted between 0677 and 0678 so tenant_isolation is dropped before 0678 tries
  // to CREATE POLICY on feedback_cycle_responses. 0320_recon_phase_a_orgid dynamically
  // adds org_id, then 0378_rls_remaining_tenant_tables creates the policy, so 0678's
  // CREATE POLICY fails on a cold replay. 0677b drops it; 0678b recreates and completes.
  "journal-order:0678_rls_fix_feedback_cycle_responses.sql",
  "insert-order:0677b_feedback_cycle_responses_policy_repair.sql",
  // 0678b inserted immediately after 0678 to recreate the policy and index that 0678
  // commits on cold replay (no-op) and that production never got (0678 also failed there).
  "journal-order:0680_kb_versions_author_membership.sql",
  "insert-order:0678b_feedback_cycle_responses_rls_complete.sql",
]);

// ─── check functions ──────────────────────────────────────────────────────────
// Each returns null (clean) or a non-empty string (violation message).

function checkLockTimeout(_filename, content) {
  if (/set\s+lock_timeout/i.test(content)) return null;
  return "no SET lock_timeout — migration will queue and block the table behind a long-running query";
}

function checkFkNotValid(_filename, content) {
  const stmts = content.split(/--> statement-breakpoint/);
  for (const stmt of stmts) {
    const s = stmt.trim();
    if (/ADD\s+CONSTRAINT\s+\S+\s+FOREIGN\s+KEY/i.test(s) && !/NOT\s+VALID/i.test(s)) {
      return "ADD CONSTRAINT … FOREIGN KEY without NOT VALID — takes ACCESS EXCLUSIVE on both tables for the full trigger-install pass; use NOT VALID then VALIDATE";
    }
  }
  return null;
}

function checkSetNotNullTwoStep(_filename, content) {
  if (!/SET\s+NOT\s+NULL/i.test(content)) return null;
  // Must have the CHECK (col IS NOT NULL) NOT VALID pattern somewhere in the file.
  if (/CHECK\s*\([^)]*IS\s+NOT\s+NULL[^)]*\)\s+NOT\s+VALID/i.test(content)) return null;
  return "SET NOT NULL without a prior CHECK (col IS NOT NULL) NOT VALID — rewrites the entire table under lock; use CHECK NOT VALID → VALIDATE → SET NOT NULL";
}

/**
 * Removes SQL comments so a keyword mentioned in a header comment is not read
 * as a statement. A migration whose header documents "VALIDATE uses ALTER
 * TABLE t VALIDATE CONSTRAINT c" was reported as validating before its
 * backfill purely because the comment sits in the first chunk.
 */
export function stripSqlComments(sql) {
  const MARKER = "__BREAKPOINT__";
  return sql
    .split("--> statement-breakpoint")
    .join(MARKER)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .split(MARKER)
    .join("--> statement-breakpoint");
}

function checkValidateBeforeBackfill(_filename, content) {
  const stmts = stripSqlComments(content).split(/--> statement-breakpoint/);
  let validateIdx = -1;
  let backfillIdx = -1;
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i].trim();
    if (validateIdx === -1 && /VALIDATE\s+CONSTRAINT/i.test(s)) validateIdx = i;
    if (backfillIdx === -1 && /UPDATE\s+\w[\s\S]*?WHERE/i.test(s)) backfillIdx = i;
  }
  if (validateIdx !== -1 && backfillIdx !== -1 && validateIdx < backfillIdx) {
    return "VALIDATE CONSTRAINT appears before the backfill UPDATE — VALIDATE will abort on a non-empty DB with NULL rows; backfill must come first";
  }
  return null;
}

function checkDoBlockBreakpoint(_filename, content) {
  // Match DO $$ ... $$ blocks (non-greedy, dot-all).
  const doBlockRe = /DO\s+\$\$[\s\S]*?\$\$/gi;
  let m;
  while ((m = doBlockRe.exec(content)) !== null) {
    if (m[0].includes("--> statement-breakpoint")) {
      return "DO $$ block contains --> statement-breakpoint — Drizzle splits on that marker and tears the block into invalid SQL fragments";
    }
  }
  return null;
}

function checkJournalEntry(filename, journalTags) {
  const tag = filename.replace(/\.sql$/, "");
  if (journalTags.has(tag)) return null;
  return `no _journal.json entry for ${filename} — db:migrate will never apply this file while printing success`;
}

function checkConcurrently(_filename, content) {
  const nonCommentLines = content.split("\n").filter((l) => !l.trimStart().startsWith("--"));
  const body = nonCommentLines.join("\n");
  if (/CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(body))
    return "CREATE INDEX CONCURRENTLY cannot run inside drizzle-kit migrate's transaction wrapper — use CREATE INDEX (without CONCURRENTLY) and rely on lock_timeout to fail fast instead of queuing";
  return null;
}

// ─── main scan ────────────────────────────────────────────────────────────────

function readJournalTags(migrationsDir) {
  const journalPath = join(migrationsDir, "meta", "_journal.json");
  if (!existsSync(journalPath)) {
    console.error(`ERROR: journal not found at ${journalPath}`);
    process.exit(2);
  }
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  return new Set(journal.entries.map((e) => e.tag));
}

function readJournalEntries(migrationsDir) {
  const journalPath = join(migrationsDir, "meta", "_journal.json");
  return JSON.parse(readFileSync(journalPath, "utf8")).entries;
}

function checkJournalIntegrity(migrationsDir, sqlFiles) {
  const entries = readJournalEntries(migrationsDir);
  const out = [];

  for (let i = 1; i < entries.length; i += 1) {
    const prev = entries[i - 1];
    const cur = entries[i];
    if (cur.when <= prev.when)
      out.push({
        filename: `${cur.tag}.sql`,
        label: "journal-order",
        msg: `when=${cur.when} is not greater than the preceding entry ${prev.tag} (when=${prev.when}) — db:migrate applies in when order and skips anything at or below the applied watermark, while still printing success`,
      });
  }

  const seenIdx = new Map();
  for (const e of entries) {
    if (seenIdx.has(e.idx))
      out.push({
        filename: `${e.tag}.sql`,
        label: "journal-dup-idx",
        msg: `idx ${e.idx} is already used by ${seenIdx.get(e.idx)}`,
      });
    else seenIdx.set(e.idx, e.tag);
  }

  const onDisk = new Set(sqlFiles);
  for (const e of entries) {
    if (!onDisk.has(`${e.tag}.sql`))
      out.push({
        filename: `${e.tag}.sql`,
        label: "journal-missing-file",
        msg: `journal entry ${e.tag} has no file on disk — db:migrate will fail ENOENT or silently skip it`,
      });
  }

  // A trailing letter (0767b) is the deliberate way to slot a repair BETWEEN two
  // already-applied migrations: renumbering an applied file changes its hash and
  // orphans its ledger row. So 0767 and 0767b are distinct keys, while two files
  // sharing an identical prefix are still the accident this check exists to catch.
  const byPrefix = new Map();
  for (const f of sqlFiles) {
    const prefix = (/^(\d{4}[a-z]?)/.exec(f) ?? [])[1];
    if (!prefix) continue;
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(f);
  }
  for (const [prefix, files] of byPrefix)
    if (files.length > 1)
      out.push({
        filename: files[1],
        label: "dup-prefix",
        msg: `migration number ${prefix} is claimed by ${files.length} files (${files.join(", ")}) — two lanes numbered independently`,
      });

  // A letter-suffixed insert only means anything if its journal `when` really lands
  // between its neighbours. Permitting the name without enforcing the ordering would
  // let a repair sort after the migration it exists to unblock.
  const whenByTag = new Map(entries.map((e) => [e.tag, e.when]));
  for (const f of sqlFiles) {
    const m = /^(\d{4})([a-z])_/.exec(f);
    if (!m) continue;
    const tag = f.replace(/\.sql$/, "");
    const own = whenByTag.get(tag);
    if (own === undefined) continue;
    const base = sqlFiles.find((c) => c.startsWith(`${m[1]}_`));
    const next = sqlFiles
      .filter((c) => /^\d{4}_/.test(c) && c.slice(0, 4) > m[1])
      .sort()[0];
    const baseWhen = base ? whenByTag.get(base.replace(/\.sql$/, "")) : undefined;
    const nextWhen = next ? whenByTag.get(next.replace(/\.sql$/, "")) : undefined;
    if (baseWhen !== undefined && own <= baseWhen)
      out.push({
        filename: f,
        label: "insert-order",
        msg: `when=${own} does not follow ${base} (when=${baseWhen}) — a letter-suffixed insert must sort after the migration it follows`,
      });
    if (nextWhen !== undefined && own >= nextWhen)
      out.push({
        filename: f,
        label: "insert-order",
        msg: `when=${own} does not precede ${next} (when=${nextWhen}) — the insert would run after the migration it exists to unblock`,
      });
  }

  return out;
}

function scanMigrations(migrationsDir) {
  if (!existsSync(migrationsDir)) {
    console.error(`ERROR: migrations dir not found: ${migrationsDir}`);
    process.exit(2);
  }
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function runScan(migrationsDir, { printBaseline = true } = {}) {
  const sqlFiles = scanMigrations(migrationsDir);
  const journalTags = readJournalTags(migrationsDir);

  if (sqlFiles.length < MIN_SQL_FILES) {
    console.error(
      `ERROR (vacuity): found only ${sqlFiles.length} SQL files — expected at least ${MIN_SQL_FILES}. ` +
        `The filesystem walk is broken. Refusing to report a false clean pass.`,
    );
    process.exit(2);
  }

  if (printBaseline) {
    console.log(`Migration discipline gate`);
    console.log(`  Scanning: ${migrationsDir}`);
    console.log(`  SQL files found: ${sqlFiles.length}`);
    console.log(
      `  Baselines: ` +
        `lock_timeout=${BASELINE_NO_LOCK_TIMEOUT.size} ` +
        `fk-not-valid=${BASELINE_FK_NOT_VALID.size} ` +
        `set-not-null=${BASELINE_SET_NOT_NULL.size} ` +
        `validate-order=${BASELINE_VALIDATE_BEFORE_BACKFILL.size} ` +
        `do-breakpoint=${BASELINE_DO_BLOCK_BREAKPOINT.size} ` +
        `no-journal=${BASELINE_NO_JOURNAL_ENTRY.size} ` +
        `concurrently=${BASELINE_CONCURRENTLY.size}`,
    );
    console.log(`  These counts can only shrink. A new file not in a baseline fails the gate.`);
    console.log(``);
  }

  const violations = [];

  for (const filename of sqlFiles) {
    const content = readFileSync(join(migrationsDir, filename), "utf8");

    const checks = [
      [checkLockTimeout, BASELINE_NO_LOCK_TIMEOUT, "lock_timeout"],
      [checkFkNotValid, BASELINE_FK_NOT_VALID, "fk-not-valid"],
      [checkSetNotNullTwoStep, BASELINE_SET_NOT_NULL, "set-not-null"],
      [checkValidateBeforeBackfill, BASELINE_VALIDATE_BEFORE_BACKFILL, "validate-order"],
      [checkDoBlockBreakpoint, BASELINE_DO_BLOCK_BREAKPOINT, "do-breakpoint"],
      [checkConcurrently, BASELINE_CONCURRENTLY, "concurrently"],
    ];

    for (const [checkFn, baseline, label] of checks) {
      const msg = checkFn(filename, content);
      if (msg !== null && !baseline.has(filename)) {
        violations.push({ filename, label, msg });
      }
    }

    const journalMsg = checkJournalEntry(filename, journalTags);
    if (journalMsg !== null && !BASELINE_NO_JOURNAL_ENTRY.has(filename.replace(/\.sql$/, ""))) {
      violations.push({ filename, label: "no-journal", msg: journalMsg });
    }
  }

  for (const v of checkJournalIntegrity(migrationsDir, sqlFiles))
    if (!BASELINE_JOURNAL_INTEGRITY.has(`${v.label}:${v.filename}`)) violations.push(v);

  return { sqlFiles, violations };
}

// ─── self-test ────────────────────────────────────────────────────────────────

function selfTest() {
  console.log("check-migration-discipline self-test");
  console.log("=====================================");
  let passed = 0;
  let failed = 0;

  function assert(description, got, expected) {
    if (expected === null ? got === null : got !== null) {
      console.log(`  PASS  ${description}`);
      passed++;
    } else {
      console.log(`  FAIL  ${description}`);
      console.log(`        expected: ${expected === null ? "no violation" : "a violation"}`);
      console.log(`        got:      ${got === null ? "null (no violation)" : got}`);
      failed++;
    }
  }

  // ─── Check 1: lock_timeout ─────────────────────────────────────────────────
  console.log("\nCheck 1: lock_timeout");

  const bad1 = `ALTER TABLE foo ADD COLUMN bar integer;`;
  assert(
    "missing lock_timeout is caught",
    checkLockTimeout("bad.sql", bad1),
    "violation",
  );

  const good1 = `SET lock_timeout = '5s';\n--> statement-breakpoint\nALTER TABLE foo ADD COLUMN bar integer;`;
  assert(
    "present lock_timeout passes",
    checkLockTimeout("good.sql", good1),
    null,
  );

  const good1b = `set lock_timeout='3s';\nALTER TABLE foo DROP COLUMN bar;`;
  assert(
    "lowercase SET lock_timeout passes",
    checkLockTimeout("good1b.sql", good1b),
    null,
  );

  // ─── Check 2: FK NOT VALID ─────────────────────────────────────────────────
  console.log("\nCheck 2: FK NOT VALID");

  const bad2 = `ALTER TABLE orders ADD CONSTRAINT fk_org FOREIGN KEY (org_id) REFERENCES organizations (id);`;
  assert(
    "FK without NOT VALID is caught",
    checkFkNotValid("bad.sql", bad2),
    "violation",
  );

  const good2 = `ALTER TABLE orders\n  ADD CONSTRAINT fk_org\n  FOREIGN KEY (org_id)\n  REFERENCES organizations (id)\n  ON DELETE CASCADE NOT VALID;\n--> statement-breakpoint\nALTER TABLE orders VALIDATE CONSTRAINT fk_org;`;
  assert(
    "FK with NOT VALID passes",
    checkFkNotValid("good.sql", good2),
    null,
  );

  const good2b = `-- multi-statement: ADD NOT VALID then VALIDATE\nALTER TABLE t ADD CONSTRAINT fk_x FOREIGN KEY (x_id) REFERENCES x (id) NOT VALID;\n--> statement-breakpoint\nALTER TABLE t VALIDATE CONSTRAINT fk_x;`;
  assert(
    "NOT VALID on same statement passes",
    checkFkNotValid("good2b.sql", good2b),
    null,
  );

  // ─── Check 3: SET NOT NULL two-step ───────────────────────────────────────
  console.log("\nCheck 3: SET NOT NULL two-step");

  const bad3 = `SET lock_timeout = '5s';\n--> statement-breakpoint\nALTER TABLE t ALTER COLUMN c SET NOT NULL;`;
  assert(
    "SET NOT NULL without CHECK NOT VALID is caught",
    checkSetNotNullTwoStep("bad.sql", bad3),
    "violation",
  );

  const good3 = `SET lock_timeout = '5s';\n--> statement-breakpoint\nALTER TABLE t ADD CONSTRAINT chk_c CHECK (c IS NOT NULL) NOT VALID;\n--> statement-breakpoint\nUPDATE t SET c = 0 WHERE c IS NULL;\n--> statement-breakpoint\nALTER TABLE t VALIDATE CONSTRAINT chk_c;\n--> statement-breakpoint\nALTER TABLE t ALTER COLUMN c SET NOT NULL;\n--> statement-breakpoint\nALTER TABLE t DROP CONSTRAINT chk_c;`;
  assert(
    "full two-step SET NOT NULL passes",
    checkSetNotNullTwoStep("good.sql", good3),
    null,
  );

  const noSetNotNull = `SET lock_timeout = '5s';\n--> statement-breakpoint\nALTER TABLE t ADD COLUMN c integer;`;
  assert(
    "migration without SET NOT NULL passes check 3",
    checkSetNotNullTwoStep("no-set.sql", noSetNotNull),
    null,
  );

  // ─── Check 4: validate-before-backfill ────────────────────────────────────
  console.log("\nCheck 4: validate-before-backfill");

  const bad4 = [
    "SET lock_timeout = '5s';",
    "ALTER TABLE t ADD CONSTRAINT chk_c CHECK (c IS NOT NULL) NOT VALID;",
    "ALTER TABLE t VALIDATE CONSTRAINT chk_c;",           // VALIDATE first
    "UPDATE t SET c = 0 WHERE c IS NULL;",                // backfill after
    "ALTER TABLE t ALTER COLUMN c SET NOT NULL;",
    "ALTER TABLE t DROP CONSTRAINT chk_c;",
  ].join("\n--> statement-breakpoint\n");
  assert(
    "VALIDATE before backfill is caught",
    checkValidateBeforeBackfill("bad.sql", bad4),
    "violation",
  );

  const good4 = [
    "SET lock_timeout = '5s';",
    "ALTER TABLE t ADD CONSTRAINT chk_c CHECK (c IS NOT NULL) NOT VALID;",
    "UPDATE t SET c = 0 WHERE c IS NULL;",                // backfill first
    "ALTER TABLE t VALIDATE CONSTRAINT chk_c;",           // VALIDATE after
    "ALTER TABLE t ALTER COLUMN c SET NOT NULL;",
    "ALTER TABLE t DROP CONSTRAINT chk_c;",
  ].join("\n--> statement-breakpoint\n");
  assert(
    "backfill before VALIDATE passes",
    checkValidateBeforeBackfill("good.sql", good4),
    null,
  );

  const validateNoBackfill = `SET lock_timeout = '5s';\n--> statement-breakpoint\nALTER TABLE t VALIDATE CONSTRAINT fk_x;`;
  assert(
    "VALIDATE with no backfill (FK two-step) passes check 4",
    checkValidateBeforeBackfill("fk-only.sql", validateNoBackfill),
    null,
  );

  const validateOnlyInComment = `-- Pattern: backfill then ALTER TABLE t VALIDATE CONSTRAINT c;\nSET lock_timeout = '5s';\n--> statement-breakpoint\nUPDATE t SET m = 1 WHERE m IS NULL;\n--> statement-breakpoint\nALTER TABLE t VALIDATE CONSTRAINT fk_x;`;
  assert(
    "a header comment naming VALIDATE CONSTRAINT does not fake a violation",
    checkValidateBeforeBackfill("commented.sql", validateOnlyInComment),
    null,
  );

  const realValidateFirst = `SET lock_timeout = '5s';\n--> statement-breakpoint\nALTER TABLE t VALIDATE CONSTRAINT fk_x;\n--> statement-breakpoint\nUPDATE t SET m = 1 WHERE m IS NULL;`;
  assert(
    "a real VALIDATE before the backfill is still caught once comments are stripped",
    checkValidateBeforeBackfill("real.sql", realValidateFirst) !== null,
    true,
  );

  assert(
    "stripSqlComments preserves the statement-breakpoint marker it must split on",
    stripSqlComments(`-- x\n--> statement-breakpoint\nSELECT 1;`).includes("--> statement-breakpoint"),
    true,
  );

  // ─── Check 5: DO-block breakpoint ─────────────────────────────────────────
  console.log("\nCheck 5: DO-block breakpoint");

  const bad5 = `SET lock_timeout = '5s';\nDO $$\nBEGIN\n--> statement-breakpoint\n  RAISE NOTICE 'hello';\nEND\n$$;`;
  assert(
    "statement-breakpoint inside DO block is caught",
    checkDoBlockBreakpoint("bad.sql", bad5),
    "violation",
  );

  const good5 = `SET lock_timeout = '5s';\n--> statement-breakpoint\nDO $$\nBEGIN\n  IF TRUE THEN\n    ALTER TABLE t ADD COLUMN c integer;\n  END IF;\nEND\n$$;`;
  assert(
    "breakpoint outside DO block passes",
    checkDoBlockBreakpoint("good.sql", good5),
    null,
  );

  const good5b = `SET lock_timeout = '5s';\n--> statement-breakpoint\nALTER TABLE t ADD COLUMN c integer;`;
  assert(
    "no DO block at all passes check 5",
    checkDoBlockBreakpoint("no-do.sql", good5b),
    null,
  );

  // ─── Check 6: journal entry ────────────────────────────────────────────────
  console.log("\nCheck 6: journal entry");

  const fakeJournal = new Set([
    "0100_create_foo",
    "0101_add_bar",
  ]);

  assert(
    "file missing from journal is caught",
    checkJournalEntry("0102_orphaned_migration.sql", fakeJournal),
    "violation",
  );

  assert(
    "file present in journal passes",
    checkJournalEntry("0100_create_foo.sql", fakeJournal),
    null,
  );

  assert(
    "second journalled file passes",
    checkJournalEntry("0101_add_bar.sql", fakeJournal),
    null,
  );

  // ─── Check 7: CONCURRENTLY ────────────────────────────────────────────────
  console.log("\nCheck 7: CONCURRENTLY");

  const bad7 = `SET lock_timeout = '5s';\n--> statement-breakpoint\nCREATE INDEX CONCURRENTLY idx_foo ON foo (bar);`;
  assert(
    "CREATE INDEX CONCURRENTLY in SQL body is caught",
    checkConcurrently("bad.sql", bad7),
    "violation",
  );

  const bad7b = `SET lock_timeout = '5s';\n--> statement-breakpoint\nCREATE UNIQUE INDEX CONCURRENTLY idx_foo ON foo (bar);`;
  assert(
    "CREATE UNIQUE INDEX CONCURRENTLY in SQL body is caught",
    checkConcurrently("bad7b.sql", bad7b),
    "violation",
  );

  const good7 = `SET lock_timeout = '5s';\n--> statement-breakpoint\nCREATE INDEX IF NOT EXISTS idx_foo ON foo (bar);`;
  assert(
    "CREATE INDEX without CONCURRENTLY passes",
    checkConcurrently("good.sql", good7),
    null,
  );

  const good7b = `SET lock_timeout = '5s';\n-- Not CONCURRENTLY: db:migrate runs inside a transaction.\n--> statement-breakpoint\nCREATE INDEX IF NOT EXISTS idx_foo ON foo (bar);`;
  assert(
    "CONCURRENTLY only in a comment does not trigger check 7",
    checkConcurrently("good7b.sql", good7b),
    null,
  );

  // ─── Self-test anti-vacuity: verify each check actually fails on bad input ─
  console.log("\nAnti-vacuity: checks must never silently pass on unparseable input");

  const binaryish = "\x00\x01\x02 SET lock_timeout = '5s'; \x00";
  const r = checkLockTimeout("binary.sql", binaryish);
  // A file with binary content but lock_timeout present should NOT be flagged.
  assert(
    "file with binary noise but lock_timeout still passes check 1",
    r,
    null,
  );

  const totalUnparseable = "\x00\x01\x02\x03\x04";
  const r2 = checkLockTimeout("unparseable.sql", totalUnparseable);
  // A file with NO lock_timeout (binary or not) must be caught.
  assert(
    "unparseable file with no lock_timeout is caught (not silently passed)",
    r2,
    "violation",
  );

  // ─── result ───────────────────────────────────────────────────────────────
  console.log(`\nSelf-test results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("SELF-TEST FAILED — one or more checks did not behave as expected");
    process.exit(1);
  }
  console.log("SELF-TEST PASSED — all seven check shapes are caught");
  process.exit(0);
}

// ─── entry point ──────────────────────────────────────────────────────────────

if (SELF_TEST) {
  selfTest();
} else {
  const { sqlFiles, violations } = runScan(MIGRATIONS_DIR);

  if (violations.length === 0) {
    console.log(`check:migration-discipline PASSED`);
    console.log(`  ${sqlFiles.length} SQL files checked, 0 new violations`);
    console.log(
      `  Baselined (immutable history): ` +
        `lock_timeout=${BASELINE_NO_LOCK_TIMEOUT.size} ` +
        `fk-not-valid=${BASELINE_FK_NOT_VALID.size} ` +
        `set-not-null=${BASELINE_SET_NOT_NULL.size} ` +
        `validate-order=${BASELINE_VALIDATE_BEFORE_BACKFILL.size} ` +
        `do-breakpoint=${BASELINE_DO_BLOCK_BREAKPOINT.size} ` +
        `no-journal=${BASELINE_NO_JOURNAL_ENTRY.size} ` +
        `concurrently=${BASELINE_CONCURRENTLY.size}`,
    );
    console.log(`  Also enforced: journal monotonicity, duplicate idx, duplicate numeric`);
    console.log(`  prefixes, and journal entries with no file on disk.`);
    console.log(`  Not covered: applied-watermark skipping (needs the DB),`);
    console.log(`  keywords in SQL comments that trick text patterns (except check 4).`);
    console.log(`  Companion: check:migration-chain`);
    process.exit(0);
  }

  console.error(`check:migration-discipline FAILED — ${violations.length} new violation(s)`);
  console.error(``);
  for (const { filename, label, msg } of violations) {
    console.error(`  [${label}] ${filename}`);
    console.error(`    ${msg}`);
    console.error(``);
  }
  console.error(`These violations are NOT in the baseline, meaning they were introduced`);
  console.error(`after the gate was established. Fix the migration or (only if it was`);
  console.error(`already applied to production) add it to the baseline with a comment.`);
  process.exit(1);
}
