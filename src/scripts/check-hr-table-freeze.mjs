#!/usr/bin/env node
/**
 * Gate: HR table count is frozen.
 *
 * db/schema/hr/ holds 234 tables. No new table may appear without an approved
 * exception because new HR state must go onto existing lifecycle columns
 * (hr_employments.status, hr_people.*) or the custom-field engine
 * (custom_field_definitions + entity JSONB). Backend CLAUDE.md §1:
 * "HR's table count is frozen — 27% of all endpoints before this rule."
 *
 * SQL-managed tables (those in hrms-phase1-sql-managed.ts and deliberately
 * excluded from the runtime barrel) are still included in the BASELINE —
 * their unimported state is by design, not a signal to delete them.
 *
 * Approved exceptions (tables added by a subsequent PR with a documented
 * reason) go into APPROVED_EXCEPTIONS below; each entry must include a
 * rationale and the PR/ticket that approved it.
 *
 * Flags:
 *   --self-test   Run internal bite-proof assertions and exit. No filesystem scan.
 *
 * Usage:  node src/scripts/check-hr-table-freeze.mjs
 *         node src/scripts/check-hr-table-freeze.mjs --self-test
 * Exit:   0 all tables approved  ·  1 unapproved table or self-test failure
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const SCHEMA_ROOT = join(SCRIPT_DIR, "../db/schema/hr");

const MIN_FILES = 50;

const BASELINE = new Set([
  "alumni_profiles",
  "announcement_reads",
  "announcement_targets",
  "announcements",
  "assessment_attempts",
  "assets",
  "attendance",
  "attendance_correction_links",
  "attendance_daily_projections",
  "attendance_event_evidence",
  "attendance_event_locators",
  "attendance_events",
  "attendance_evidence_legal_holds",
  "attendance_session_projections",
  "background_verifications",
  "biometric_devices",
  "biometric_logs",
  "booking_link_interviewers",
  "calibration_participants",
  "calibration_sessions",
  "candidate_applications",
  "candidate_documents",
  "candidate_documents_vault",
  "candidate_messages",
  "candidate_offers",
  "candidate_reference_checks",
  "candidate_referrals",
  "candidate_resumes",
  "candidate_sla_tracking",
  "candidate_sources",
  "candidates",
  "certifications",
  "comp_off_balances",
  "competencies",
  "competency_frameworks",
  "document_audit_logs",
  "document_template_versions",
  "document_templates",
  "document_type_roles",
  "document_types",
  "documents",
  "email_sequence_enrollments",
  "email_sequence_steps",
  "email_sequences",
  "employee_devices",
  "employee_shift_assignments",
  "employee_skills",
  "enps_scores",
  "exit_checklists",
  "external_referrals",
  "external_referrers",
  "feedback_cycle_requests",
  "feedback_cycle_responses",
  "feedback_cycles",
  "feedback_requests",
  "gdpr_export_jobs",
  "geofences",
  "goals",
  "handbook_versions",
  "headcount_requests",
  "helpdesk_tickets",
  "hiring_flow_rounds",
  "hiring_flows",
  "holidays",
  "hr_access_provisioning",
  "hr_access_provisioning_templates",
  "hr_access_requests",
  "hr_accommodation_requests",
  "hr_accommodation_tasks",
  "hr_arrears_adjustments",
  "hr_attendance_regularizations",
  "hr_audit_event_sources",
  "hr_audit_events",
  "hr_audit_logs",
  "hr_automation_rules",
  "hr_automation_runs",
  "hr_badge_awards",
  "hr_badges",
  "hr_benefit_enrollment_windows",
  "hr_benefit_enrollments",
  "hr_benefit_plans",
  "hr_calibration_entries",
  "hr_campaigns",
  "hr_case_documents",
  "hr_case_notes",
  "hr_cases",
  "hr_collective_agreements",
  "hr_communities",
  "hr_community_members",
  "hr_comp_budget_pools",
  "hr_comp_cycles",
  "hr_comp_recommendations",
  "hr_compliance_events",
  "hr_compliance_requirements",
  "hr_contracts",
  "hr_data_requests",
  "hr_dependents",
  "hr_device_employee_mappings",
  "hr_device_sync_logs",
  "hr_disciplinary_actions",
  "hr_document_tags",
  "hr_effective_dated_changes",
  "hr_email_templates",
  "hr_emergency_events",
  "hr_emergency_responses",
  "hr_employee_sensitive_disciplinary_records",
  "hr_employee_sensitive_fields",
  "hr_employee_sensitive_grievance_records",
  "hr_employment_custom_field_values",
  "hr_employment_history",
  "hr_employment_legacy_map",
  "hr_employments",
  "hr_equity_exercises",
  "hr_equity_grants",
  "hr_equity_vesting_events",
  "hr_event_stream",
  "hr_export_jobs",
  "hr_form_submissions",
  "hr_forms",
  "hr_headcount_plans",
  "hr_helpdesk_comments",
  "hr_helpdesk_routing",
  "hr_import_jobs",
  "hr_import_rows",
  "hr_insurance_claims",
  "hr_job_levels",
  "hr_job_roles",
  "hr_labor_cases",
  "hr_leave_ledger",
  "hr_legal_hold_items",
  "hr_legal_holds",
  "hr_loan_repayments",
  "hr_mood_checkins",
  "hr_payroll_compliance_tasks",
  "hr_payroll_variance_approvals",
  "hr_people",
  "hr_person_legacy_map",
  "hr_policies",
  "hr_policy_scopes",
  "hr_poll_votes",
  "hr_polls",
  "hr_position_statuses",
  "hr_position_transitions",
  "hr_positions",
  "hr_probation_reviews",
  "hr_proxy_access",
  "hr_reorg_scenarios",
  "hr_reporting_lines",
  "hr_retention_policies",
  "hr_reward_points_ledger",
  "hr_role_skill_requirements",
  "hr_safety_incidents",
  "hr_simulations",
  "hr_succession_plans",
  "hr_template_renders",
  "hr_templates",
  "hr_time_devices",
  "hr_travel_visit_logs",
  "hr_union_memberships",
  "hr_webhook_deliveries",
  "hr_webhook_subscriptions",
  "hr_wellness_checkins",
  "hr_work_authorizations",
  "hr_workflow_definitions",
  "hr_workflow_delegations",
  "hr_workflow_instance_attachments",
  "hr_workflow_instances",
  "hr_workflow_step_actions",
  "hr_workflow_steps",
  "hr_workforce_reconciliation_items",
  "interview_booking_links",
  "interview_panel_members",
  "interview_questions",
  "interview_scorecards",
  "interview_slas",
  "interviews",
  "investment_proofs",
  "job_board_postings",
  "job_postings",
  "job_recruiters",
  "job_requisitions",
  "key_results",
  "kpi_definitions",
  "leave_balances",
  "leave_blackout_dates",
  "leave_policies",
  "leave_requests",
  "leave_types",
  "offer_letter_templates",
  "offer_negotiations",
  "offer_versions",
  "onboarding_documents",
  "onboarding_task_dependencies",
  "onboarding_tasks",
  "onboarding_template_steps",
  "onboarding_templates",
  "one_on_one_meetings",
  "overtime_requests",
  "performance_improvement_plans",
  "performance_reviews",
  "pipeline_automations",
  "policy_acknowledgments",
  "pulse_surveys",
  "recognitions",
  "recruiter_activity_log",
  "recruitment_vendors",
  "resignations",
  "review_cycles",
  "rich_documents",
  "roster_entries",
  "rosters",
  "salary_structure_templates",
  "scheduled_reports",
  "scorecard_templates",
  "shift_swap_requests",
  "shift_templates",
  "skill_assessments",
  "survey_responses",
  "talent_pool_members",
  "talent_pools",
  "tax_declarations",
  "team_event_participants",
  "team_events",
  "termination_reasons",
  "termination_supporting_documents",
  "terminations",
  "travel_requests",
  "vault_access_logs",
  "vendor_candidate_submissions",
  "wfh_requests",
  "worker_leave_balance_projections",
  "worker_leave_entry_locators",
  "worker_leave_ledger_entries",
  "worker_leave_reversal_links",
]);

const APPROVED_EXCEPTIONS = new Set([
  // helpdesk_queues — one row per (org, queue) holding the queue's first-response and
  // resolution SLA hours and its escalation actor. Per-queue configuration is neither a
  // lifecycle column on hr_helpdesk_tickets nor a custom field: it is read by the
  // escalation sweep for every open ticket and enforced by the composite FK that pins the
  // escalation actor to the same tenant. Approved with HRMS_AUDIT_2026-09-21 (company-wide
  // employee support with HR/IT/Finance/Admin/Legal queues), branch
  // feat/employee-support-queues, commits c2ce98cfc / 08d8f886f, migration 1135.
  "helpdesk_queues",
  // document_audiences — the set of (kind, ref) pairs a document may be shown to: all employees, one
  // department, one location. Many rows per document, so neither a lifecycle column on `documents` nor a
  // custom field; it is the ceiling a knowledge-base link's own audience must stay inside, read by the audience
  // predicate for every employee. document_versions — the file history of a document (`documents.version` has
  // been 1 on every row and `parent_document_id` has never been written): many rows per document, holding the
  // pending upload and what a pinned link resolves against, while `documents` keeps the current approved file so
  // every existing reader is unchanged. Approved with the HRMS-KB project (docs/hrms-kb/PLAN.md §3.1), branch
  // hrms-kb/pr-2-schema-and-flags, migration 1198.
  "document_audiences",
  "document_versions",
]);

function extractTableNames(src) {
  const lines = src.split("\n");
  const found = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/pgTable\s*\(/.test(line)) continue;
    const sameLine = line.match(/pgTable\s*\(\s*["']([a-z_]+)["']/);
    if (sameLine) {
      found.add(sameLine[1]);
      continue;
    }
    const next = i + 1 < lines.length ? lines[i + 1] : "";
    const nextLine = next.match(/^\s*["']([a-z_]+)["']/);
    if (nextLine) found.add(nextLine[1]);
  }
  return found;
}

function collectSchemaFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...collectSchemaFiles(full));
    } else if (st.isFile() && extname(entry) === ".ts" && !entry.endsWith(".spec.ts") && entry !== "index.ts" && entry !== "recruitment.ts") {
      files.push(full);
    }
  }
  return files;
}

function runSelfTests() {
  let passed = 0;
  let failed = 0;

  function assert(label, cond) {
    if (cond) {
      passed++;
    } else {
      process.stderr.write(`  SELF-TEST FAIL: ${label}\n`);
      failed++;
    }
  }

  const sameLine = `export const hrFoo = pgTable("hr_foo_same_line", {\n  id: serial("id").primaryKey(),\n});`;
  const names1 = extractTableNames(sameLine);
  assert("same-line table name extracted", names1.has("hr_foo_same_line"));
  assert("serial id field not extracted as table", !names1.has("id"));

  const nextLine = `export const hrBar = pgTable(\n  "hr_bar_next_line",\n  {\n    id: serial("id").primaryKey(),\n  }\n);`;
  const names2 = extractTableNames(nextLine);
  assert("next-line table name extracted", names2.has("hr_bar_next_line"));

  const approvedSrc = `export const hrPeople = pgTable("hr_people", {\n  id: serial("id").primaryKey(),\n});`;
  const approvedNames = extractTableNames(approvedSrc);
  const falsePositives = [...approvedNames].filter((n) => !BASELINE.has(n) && !APPROVED_EXCEPTIONS.has(n));
  assert("baseline table does not trigger a violation", falsePositives.length === 0);

  const unapprovedSrc = `export const hrNewUnapproved = pgTable("hr_completely_new_unapproved_table", {\n  id: serial("id").primaryKey(),\n});`;
  const unapprovedNames = extractTableNames(unapprovedSrc);
  const violations = [...unapprovedNames].filter((n) => !BASELINE.has(n) && !APPROVED_EXCEPTIONS.has(n));
  assert("gate bites on unapproved new table", violations.length === 1);
  assert("correct unapproved table name flagged", violations[0] === "hr_completely_new_unapproved_table");

  const combinedSrc = [
    `export const hrPeople = pgTable("hr_people", {\n  id: serial("id").primaryKey(),\n});`,
    `export const hrBrand = pgTable(\n  "hr_brand_new_unapproved",\n  {\n    id: serial("id").primaryKey(),\n  }\n);`,
  ].join("\n\n");
  const combinedNames = extractTableNames(combinedSrc);
  const combinedViolations = [...combinedNames].filter((n) => !BASELINE.has(n) && !APPROVED_EXCEPTIONS.has(n));
  assert("gate bites on mixed approved+unapproved content", combinedViolations.length === 1);
  assert("correct table flagged in mixed content", combinedViolations[0] === "hr_brand_new_unapproved");

  if (failed > 0) {
    process.stderr.write(`\nSelf-tests: ${failed} failed, ${passed} passed.\n`);
    process.exit(1);
  }
  process.stdout.write(`Self-tests: ${passed} passed.\n`);
  process.exit(0);
}

if (process.argv.includes("--self-test")) runSelfTests();

const files = collectSchemaFiles(SCHEMA_ROOT);

if (files.length < MIN_FILES) {
  process.stderr.write(
    `VACUITY GUARD: only ${files.length} files found under ${SCHEMA_ROOT} (expected >= ${MIN_FILES}). Check path.\n`,
  );
  process.exit(1);
}

const unapproved = [];

for (const file of files) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const names = extractTableNames(src);
  for (const name of names) {
    if (!BASELINE.has(name) && !APPROVED_EXCEPTIONS.has(name)) {
      unapproved.push({ file: file.replace(SCHEMA_ROOT, "").replace(/\\/g, "/"), table: name });
    }
  }
}

process.stdout.write(`Scanned ${files.length} HR schema files.\n`);

if (unapproved.length === 0) {
  process.stdout.write(`HR table freeze: all ${BASELINE.size} tables approved. Gate passed.\n`);
  process.exit(0);
}

process.stderr.write(`\nHR TABLE FREEZE VIOLATION — ${unapproved.length} unapproved table(s):\n\n`);
for (const v of unapproved) {
  process.stderr.write(`  ${v.file}: "${v.table}"\n`);
}
process.stderr.write(
  `\nNew HR behaviour must use existing lifecycle columns or the custom-field engine.\n` +
  `If a new normalized relationship is genuinely unavoidable, add the table name to\n` +
  `APPROVED_EXCEPTIONS in this file with a rationale and PR link.\n`,
);
process.exit(1);
