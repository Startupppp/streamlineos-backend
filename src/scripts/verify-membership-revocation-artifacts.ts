/**
 * The two catalog reporters `verify-membership-revocation` prints alongside its own result.
 *
 * Split out of that script when it crossed the 500-line review limit (CLAUDE.md section 7).
 * Both answer questions about the ARTIFACT catalog rather than about a revocation run:
 * which membership artifacts this script does not cover, and whether any artifact FK in the
 * live catalog has drifted from the removal action the catalog declares for it. Neither
 * reads the seeded fixture, and neither is called from the verification path — they are
 * reports printed beside it, which is why they move together and why the coverage set
 * comes with them.
 */
import { count, sql } from "drizzle-orm";
import type { Db } from "../db/drizzle.module";
import type { RemovalAction } from "../modules/organization/core/membership-artifacts";
import { MEMBERSHIP_ARTIFACTS } from "../modules/organization/core/membership-artifacts";

export const ARTIFACT_COVERAGE: ReadonlySet<string> = new Set([
  "role_assignments", "user_permission_grants", "principal_group_members",
  "user_delegations", "user_module_access", "agent_tokens",
  "resource_grants", "invitations",
]);

export function printUncoveredArtifacts(): void {
  const uncovered = MEMBERSHIP_ARTIFACTS.filter(
    (a) => a.table !== null && a.onRemoval !== "blocks-removal" && a.onRemoval !== "set-null" && !ARTIFACT_COVERAGE.has(a.table),
  );
  if (uncovered.length > 0) {
    console.log("\nNOTICE — inventory artifacts not checked by this script:");
    uncovered.forEach((a) => console.log(`  ${a.table ?? ""} (${a.id})`));
  }
}

const FK_ACTION_BY_CODE: Record<string, RemovalAction> = {
  c: "cascade",
  n: "set-null",
  a: "blocks-removal",
  r: "blocks-removal",
};

/**
 * Artifacts whose declared `onRemoval` is enforced by NOTHING.
 *
 * `checkArtifactFkDrift` used to print `SKIP` for these and `continue` without
 * touching `pass`, and `driftPass` is the only input to `process.exitCode` for
 * that sub-check — so "no FK exists" was indistinguishable from "the FK is
 * correct", and the gate reported PASS over 67 unenforced relationships.
 * Measured at head: 262 PASS / 0 FAIL / 67 SKIP, overall exit 0. Independently
 * confirmed against `pg_constraint`: 92 of 511 `*_membership_id` columns carry
 * no foreign key to `organization_members`.
 *
 * The trap is that the absence sits BESIDE a present one on the same table:
 * `org_units.head_membership_id` and
 * `organization_people.organization_membership_id` both have their FK, while
 * `archived_by_membership_id` and `updated_by_membership_id` on those same two
 * tables have none. On revocation the membership row goes and every dangling id
 * survives with nothing to enforce it.
 *
 * This list is the frozen measurement, NOT a justification. It exists so the
 * 68th unenforced relationship fails instead of joining a silent majority:
 *
 *   - an artifact with no FK that is NOT listed here FAILS;
 *   - an artifact listed here that HAS acquired its FK also FAILS, so the entry
 *     must be deleted in the same commit as the migration that added it.
 *
 * The list may only ever shrink. Removing an entry without adding the FK turns
 * that artifact back into a hard failure, which is the point.
 */
const UNENFORCED_MEMBERSHIP_ARTIFACTS: ReadonlySet<string> = new Set([
  "alumni_profiles_user_membership",
  "announcement_reads_user_membership",
  "assessment_attempts_user_membership",
  "assets_assigned_to_membership",
  "attendance_user_membership",
  "background_verifications_user_membership",
  "biometric_logs_user_membership",
  "booking_link_interviewers_user_actor",
  "calibration_participants_user_actor",
  "certifications_user_membership",
  "client_accounts",
  "client_onboarding_items",
  "comp_off_balances_user_membership",
  "employee_devices_user_membership",
  "employee_shift_assignments_user_membership",
  "employee_skills_user_membership",
  "enps_scores_user_membership",
  "exit_checklists_assigned_to_membership",
  "feedback_cycle_requests_memberships",
  "feedback_requests_reviewer_actor",
  "feedback_requests_subject_actor",
  "goals_user_membership",
  "hr_access_provisioning_user_membership",
  "hr_accommodation_requests_user_membership",
  "hr_accommodation_tasks_assignee_membership",
  "hr_arrears_adjustments_user_membership",
  "hr_calibration_entries_employee_membership",
  "hr_community_members_user_membership",
  "hr_comp_recommendations_user_membership",
  "hr_data_requests_subject_membership",
  "hr_device_employee_mappings_user_membership",
  "hr_emergency_responses_user_membership",
  "hr_employments_actors",
  "hr_equity_grants_user_membership",
  "hr_helpdesk_comments_author_membership",
  "hr_helpdesk_routing_assignee_membership",
  "hr_leave_ledger_user_membership",
  "hr_legal_holds_subject_membership",
  "hr_people_actors",
  "hr_poll_votes_user_membership",
  "hr_reward_points_ledger_user_membership",
  "hr_union_memberships_user_membership",
  "interview_panel_members_user_actor",
  "job_recruiters_user_membership",
  "job_requisitions_memberships",
  "kb_article_versions",
  "kb_page_versions",
  "leave_balances_user_membership",
  "onboarding_documents_actors",
  "onboarding_tasks_actors",
  "one_on_one_meetings_memberships",
  "org_units_archived_by_membership",
  "org_units_updated_by_membership",
  "organization_people_archived_by_membership",
  "organization_people_updated_by_membership",
  "overtime_requests_memberships",
  "performance_improvement_plans_memberships",
  "policy_acknowledgments_user_membership",
  "shift_swap_requests_memberships",
  "survey_responses_user_membership",
  "tax_declarations_user_membership",
  "team_event_participants_user_membership",
  "terminations_user_membership",
  "travel_requests_memberships",
  "worker_engagements_archived_by_membership",
  "worker_engagements_updated_by_membership",
  "workers_actors",
]);

export async function checkArtifactFkDrift(db: Db): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT
      n.nspname AS schema_name,
      cl.relname AS table_name,
      c.conname AS constraint_name,
      c.confdeltype AS delete_code,
      c.convalidated AS is_validated,
      array_length(c.confdelsetcols, 1) AS set_null_col_count,
      (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
         FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
      (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
         FROM unnest(c.confdelsetcols) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS set_null_cols
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE c.contype = 'f' AND c.confrelid = 'organization_members'::regclass
  `);
  const rows = Array.isArray(result) ? result : [];

  console.log("\n=== INVENTORY vs pg_constraint (declared onRemoval must match the real FK) ===");
  let pass = true;
  const skippedIds: string[] = [];
  for (const artifact of MEMBERSHIP_ARTIFACTS) {
    if (artifact.table === null) continue;
    if (artifact.onRemoval !== "cascade" && artifact.onRemoval !== "set-null" && artifact.onRemoval !== "blocks-removal") continue;

    const keys = artifact.keyedBy.split(/\s*\/\s*/);
    const matches = rows.filter((row) => {
      const record: Record<string, unknown> = row;
      if (String(record.table_name ?? "") !== artifact.table) return false;
      const fkCols = String(record.columns ?? "").split(",");
      return keys.some((key) => fkCols.includes(key.trim()));
    });

    if (matches.length === 0) {
      skippedIds.push(artifact.id);
      if (UNENFORCED_MEMBERSHIP_ARTIFACTS.has(artifact.id)) {
        console.log(
          `  SKIP  ${(artifact.table ?? "").padEnd(34)} no FK on [${keys.join(", ")}] references organization_members — baselined as UNENFORCED (${artifact.id})`,
        );
      } else {
        pass = false;
        console.log(
          `  FAIL  ${(artifact.table ?? "").padEnd(34)} declared=${artifact.onRemoval} but NO FK on [${keys.join(", ")}] references organization_members — nothing enforces it (${artifact.id})`,
        );
      }
      continue;
    }

    for (const match of matches) {
      const record: Record<string, unknown> = match;
      const actual = FK_ACTION_BY_CODE[String(record.delete_code ?? "")];
      let ok = actual === artifact.onRemoval;

      if (actual === "set-null") {
        const fkCols = String(record.columns ?? "").split(",");
        const hasOrgId = fkCols.includes("org_id");
        const setNullColCount = Number(record.set_null_col_count ?? 0);
        if (hasOrgId && setNullColCount === 0) {
          ok = false;
          console.log(
            `  FAIL  ${(artifact.table ?? "").padEnd(34)} SET NULL without column list on composite FK — org_id is NOT NULL, will 23502 (${String(record.constraint_name ?? "")})`,
          );
          pass = false;
          continue;
        }
      }

      if (!ok) pass = false;
      console.log(
        `  ${ok ? "PASS" : "FAIL"}  ${(artifact.table ?? "").padEnd(34)} declared=${artifact.onRemoval} actual=${actual ?? "unknown"} (${String(record.constraint_name ?? "")})`,
      );
    }
  }

  /**
   * The ratchet. A baseline entry whose FK now exists is a STALE entry, and a
   * stale entry is what lets the list stop shrinking: it would silently absorb
   * a future regression on the same artifact. Deleting it is part of the same
   * commit as the migration that adds the constraint.
   */
  const skipped = new Set(skippedIds);
  const staleBaseline = [...UNENFORCED_MEMBERSHIP_ARTIFACTS].filter(
    (id) => !skipped.has(id),
  );
  console.log(
    `\n  unenforced: ${skippedIds.length} measured / ${UNENFORCED_MEMBERSHIP_ARTIFACTS.size} baselined`,
  );
  if (staleBaseline.length > 0) {
    pass = false;
    console.log(
      "\n  FAIL — the unenforced baseline is stale; these artifacts now have their FK and must be removed from UNENFORCED_MEMBERSHIP_ARTIFACTS:",
    );
    for (const id of staleBaseline) console.log(`    ${id}`);
  }

  const brokenSetNull = rows.filter((row) => {
    const record: Record<string, unknown> = row;
    if (String(record.delete_code ?? "") !== "n") return false;
    const fkCols = String(record.columns ?? "").split(",");
    if (!fkCols.includes("org_id")) return false;
    return Number(record.set_null_col_count ?? 0) === 0;
  });
  if (brokenSetNull.length > 0) {
    console.log("\n  WARNING — SET NULL FKs without column list (will 23502 if triggered):");
    for (const row of brokenSetNull) {
      const record: Record<string, unknown> = row;
      console.log(`    ${String(record.schema_name ?? "")}.${String(record.table_name ?? "")} → ${String(record.constraint_name ?? "")} on (${String(record.columns ?? "")})`);
    }
  }

  return pass;
}

