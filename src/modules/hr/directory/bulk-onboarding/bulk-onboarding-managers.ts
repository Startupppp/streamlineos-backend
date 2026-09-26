import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { canonicalAdmissionEmail } from "../../../organization/core/membership-admission.service";
import { ReportingLineService } from "../../../directory/reporting-line.service";
import { ReportingManagerFallbackResolver } from "../../../directory/reporting-manager-fallback.resolver";
import { readReportingManagerPolicy, subjectEmployments } from "../../../directory/reporting-line-queries";
import { REPORTING_LINE_ERROR_CODES } from "../../../directory/reporting-line.types";
import { orgBusinessDate } from "../../time/attendance-business-date";
import type { BulkOnboardEmployeeRow } from "../dto/hr-directory.schemas";
import type { ManagerColumnsResult, normaliseManagerColumns } from "../reporting-manager-columns";
import { peopleByEmails } from "../reporting-manager-people";
import { checkHireSecondaries } from "./bulk-onboarding-secondaries";
import type { BulkOnboardPlan, PlannedEmployee, PlannedSecondaryManager } from "./bulk-onboarding.types";

function secondaryEmailsOf(columns: ManagerColumnsResult | undefined): string[] {
  return columns?.ok ? columns.secondaryManagerEmails.flatMap((email) => (email ? [email] : [])) : [];
}

/** Fills each accepted row's primary (D2) and secondary managers, moving refused rows to `rejected`. */
export async function assignBulkManagers(
  db: Db,
  fallback: ReportingManagerFallbackResolver,
  reportingLines: ReportingLineService,
  actor: CurrentUserContext,
  rows: readonly BulkOnboardEmployeeRow[],
  normalised: ReadonlyArray<ReturnType<typeof normaliseManagerColumns>>,
  plan: BulkOnboardPlan,
): Promise<void> {
  const orgId = actor.orgId;
  if (plan.accepted.length === 0) return;
  // The whole file is the roster (a manager row may itself have failed, which the orphan sweep
  // then reports), so every row is passed even though only accepted rows are read back.
  const resolved = await fallback.resolveMany(
    orgId,
    actor,
    rows.map((row, index) => ({
      key: index + 1,
      employeeEmail: canonicalAdmissionEmail(row.email),
      primaryManagerUserId: row.reportingManagerUserId ?? null,
      primaryManagerEmail: row.primaryManagerEmail ?? null,
    })),
  );
  const roster = new Set(plan.accepted.map((employee) => employee.email));
  const withSecondaries = plan.accepted.filter((employee) => secondaryEmailsOf(normalised[employee.row - 1]).length > 0);
  const secondaryEmails = withSecondaries.flatMap((employee) => secondaryEmailsOf(normalised[employee.row - 1]));
  const people = await peopleByEmails(db, orgId, secondaryEmails);
  const rules = withSecondaries.length > 0 ? await secondaryRuleInputs(db, reportingLines, orgId, [...people.values()].map((person) => person.userId), resolved) : null;
  const kept: PlannedEmployee[] = [];
  for (const employee of plan.accepted) {
    const refuse = (code: string, error: string) => plan.rejected.push({ row: employee.row, email: employee.email, success: false, error, code });
    const columns = normalised[employee.row - 1];
    if (!columns?.ok) {
      refuse(REPORTING_LINE_ERROR_CODES.MANAGER_COLUMN_CONFLICT, `The manager columns disagree: ${columns?.ok === false ? columns.conflictingColumns.join(", ") : ""}.`);
      continue;
    }
    if (!employee.source.topLevelRole) {
      const result = resolved[employee.row - 1];
      if (!result?.ok) {
        refuse(result?.code ?? REPORTING_LINE_ERROR_CODES.MANAGER_NOT_FOUND, result && !result.ok ? result.message : "The reporting manager could not be resolved.");
        continue;
      }
      employee.primaryManager = {
        userId: result.managerUserId,
        name: result.name,
        email: result.email,
        resolution: result.resolution,
        dependsOnRow: result.dependsOnRow,
      };
      employee.reportingManagerUserId = result.managerUserId;
      employee.reportingManagerEmail = result.managerUserId === null ? result.email : null;
    }
    const emails = secondaryEmailsOf(columns);
    let secondaries: PlannedSecondaryManager[] = [];
    if (emails.length > 0 && rules) {
      const checked = checkHireSecondaries({
        hire: {
          email: employee.email,
          userId: null,
          topLevelReason: employee.source.topLevelRole ? employee.source.topLevelRoleReason ?? null : null,
          effectiveFrom: employee.effectiveFrom ?? employee.joiningDate ?? rules.today,
        },
        primary: employee.source.topLevelRole ? null : { userId: employee.primaryManager?.userId ?? null, email: employee.primaryManager?.email ?? null },
        secondaryEmails: emails,
        people,
        roster,
        policy: rules.policy,
        managerChecks: rules.checks,
        managerEmployments: rules.employments,
      });
      if (!checked.ok) {
        refuse(checked.code, checked.error);
        continue;
      }
      secondaries = checked.secondaries;
    }
    employee.secondaryManagers = secondaries;
    kept.push(employee);
  }
  plan.accepted = kept;
  plan.rejected.sort((left, right) => left.row - right.row);
}

/** One policy read, one eligibility check and one employment-window read for every secondary of the file. */
async function secondaryRuleInputs(db: Db, reportingLines: ReportingLineService, orgId: string, secondaryUserIds: string[], resolved: Awaited<ReturnType<ReportingManagerFallbackResolver["resolveMany"]>>) {
  const primaryUserIds = resolved.flatMap((result) => (result.ok && result.managerUserId ? [result.managerUserId] : []));
  const [policy, checks, today] = await Promise.all([
    readReportingManagerPolicy(db, orgId),
    reportingLines.checkManagers(orgId, [...new Set([...secondaryUserIds, ...primaryUserIds])]),
    orgBusinessDate(db, orgId),
  ]);
  const employmentIds = [...checks.values()].flatMap((check) => (check.ok ? [check.managerEmploymentId] : []));
  const employments = new Map((await subjectEmployments(db, orgId, { employmentIds })).map((row) => [row.employmentId, row]));
  return { policy, checks, today, employments };
}
