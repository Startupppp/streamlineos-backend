import { canonicalAdmissionEmail } from "../../../organization/core/membership-admission.service";
import { REPORTING_LINE_WARNINGS } from "../../../directory/reporting-line.types";
import type { BulkOnboardEmployeeRow } from "../dto/hr-directory.schemas";
import type { BulkOnboardPreview } from "../dto/reporting-lines-bulk.schemas";
import type { BulkOnboardPlan, PlannedEmployee } from "./bulk-onboarding.types";

export function primaryManagerOf(employee: PlannedEmployee): BulkOnboardPreview["rows"][number]["primaryManager"] {
  const manager = employee.primaryManager;
  if (!manager) return null;
  return { userId: manager.userId, name: manager.name ?? manager.email ?? "", email: manager.email ?? "", resolution: manager.resolution };
}

export function onboardingWarnings(employee: PlannedEmployee, departmentsToCreate: readonly string[]): { codes: string[]; messages: string[] } {
  const codes: string[] = [];
  const messages: string[] = [];
  const manager = employee.primaryManager;
  if (manager && (manager.resolution === "FALLBACK_CONFIGURED" || manager.resolution === "FALLBACK_UPLOADER")) {
    codes.push(REPORTING_LINE_WARNINGS.FALLBACK_ASSIGNED);
    messages.push(
      manager.resolution === "FALLBACK_CONFIGURED"
        ? `No manager given: ${manager.name ?? manager.email ?? "the default manager"} is assigned as the organization's default reporting manager.`
        : `No manager given: ${manager.name ?? manager.email ?? "you"} (the uploader) is assigned by the fallback policy.`,
    );
  }
  const department = employee.source.department?.trim();
  if (department && departmentsToCreate.some((name) => name.toLowerCase() === department.toLowerCase())) {
    codes.push("DEPARTMENT_WILL_BE_CREATED");
    messages.push(`Department "${department}" does not exist yet and will be created.`);
  }
  return { codes, messages };
}

export function buildOnboardingPreview(
  rows: readonly BulkOnboardEmployeeRow[],
  planned: { plan: BulkOnboardPlan; departmentsToCreate: readonly string[] },
): BulkOnboardPreview {
  const accepted = new Map(planned.plan.accepted.map((employee) => [employee.row, employee]));
  const rejected = new Map(planned.plan.rejected.map((entry) => [entry.row, entry]));
  const counts = { ready: 0, warning: 0, error: 0, skipped: 0 };
  const previewRows = rows.map((source, index) => {
    const row = index + 1;
    const employee = accepted.get(row);
    const refusal = rejected.get(row);
    const email = canonicalAdmissionEmail(source.email);
    if (!employee) {
      const skipped = refusal?.skipped === true;
      counts[skipped ? "skipped" : "error"] += 1;
      return {
        row,
        email,
        status: skipped ? ("SKIPPED" as const) : ("ERROR" as const),
        codes: refusal?.code ? [refusal.code] : [],
        messages: refusal?.error ? [refusal.error] : [],
        primaryManager: null,
        secondaryManagers: [],
        dependsOnRow: refusal?.dependsOnRow ?? null,
      };
    }
    const warnings = onboardingWarnings(employee, planned.departmentsToCreate);
    counts[warnings.codes.length > 0 ? "warning" : "ready"] += 1;
    return {
      row,
      email,
      status: warnings.codes.length > 0 ? ("WARNING" as const) : ("READY" as const),
      codes: warnings.codes,
      messages: warnings.messages,
      primaryManager: primaryManagerOf(employee),
      secondaryManagers: employee.secondaryManagers.map((manager) => ({ name: manager.name ?? manager.email, email: manager.email })),
      dependsOnRow: employee.primaryManager?.dependsOnRow ?? null,
    };
  });
  return { rows: previewRows, counts };
}
