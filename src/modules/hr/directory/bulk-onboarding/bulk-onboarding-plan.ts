import { and, eq, inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { hrEmployments, hrPeople, organizationMembers, users } from "../../../../db/schema";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";
import {
  liveEmployment,
  livePersonOfEmployment,
} from "../../../directory/employment-query";
import { ORG_MEMBER_ROLES } from "../../../../common/rbac/org-roles";
import { formatDateOnly } from "../../../../common/date";
import {
  admissionRefusalMessage,
  canonicalAdmissionEmail,
  type AdmissionScreen,
} from "../../../organization/core/membership-admission.service";
import {
  dateOfBirthProblem,
  type BulkOnboardEmployeeRow,
} from "../dto/hr-directory.schemas";
import type { DepartmentCatalog } from "./bulk-onboarding-departments";
import type { BulkOnboardPlan } from "./bulk-onboarding.types";
import { findManagerCycles, rosterEmailsOf, type ManagerEdge } from "./bulk-onboarding-graph";

const EMP_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomEmployeeCode(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += EMP_CODE_ALPHABET[bytes[i] % EMP_CODE_ALPHABET.length];
  return out;
}

export async function preloadEmployeeNumbers(
  db: DbOrTx,
  orgId: string,
  employeeNumbers: readonly string[],
): Promise<Map<string, string | null>> {
  const owners = new Map<string, string | null>();
  if (employeeNumbers.length === 0) return owners;

  const taken = await db
    .select({
      employeeNumber: hrEmployments.employeeNumber,
      userId: hrPeople.userId,
    })
    .from(hrEmployments)
    .innerJoin(hrPeople, livePersonOfEmployment(orgId))
    .where(
      and(
        liveEmployment(orgId),
        eq(hrEmployments.isPrimary, true),
        inArray(hrEmployments.employeeNumber, [...employeeNumbers]),
      ),
    )
    .limit(employeeNumbers.length);
  for (const row of taken) owners.set(row.employeeNumber, row.userId);

  return owners;
}

export function distinctRoles(rows: readonly BulkOnboardEmployeeRow[]): string[] {
  return [...new Set(rows.map((row) => row.role || ORG_MEMBER_ROLES.MEMBER))];
}

function resolveDepartment(
  row: BulkOnboardEmployeeRow,
  catalog: DepartmentCatalog,
): { departmentId: string | null } | { error: string } {
  if (row.departmentId != null) {
    if (!catalog.activeIds.has(row.departmentId))
      return { error: "Unknown department. Create it under Organization → Departments (or HR departments) first." };
    return { departmentId: row.departmentId };
  }
  if (!row.department) return { departmentId: null };
  const resolved = catalog.byKey.get(row.department.trim().toLowerCase());
  if (!resolved)
    return {
      error: `Unknown department "${row.department}". Create it under Organization → Departments (or HR departments) first.`,
    };
  return { departmentId: resolved };
}

export async function preloadManagerUserIdsByEmail(
  db: DbOrTx,
  orgId: string,
  emails: readonly string[],
): Promise<Map<string, string>> {
  if (emails.length === 0) return new Map();
  const rows = await db
    .select({ email: users.email, userId: organizationMembers.userId })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.status, "ACTIVE"),
        inArray(users.email, [...emails]),
      ),
    );
  return new Map(rows.map((row) => [canonicalAdmissionEmail(row.email), row.userId]));
}

interface ResolvedManager {
  reportingManagerUserId: string | null;
  /** Set when the manager is another row of this same file, resolved after admission. */
  reportingManagerEmail: string | null;
}

/**
 * A manager is either already in the organisation, or introduced by this file.
 *
 * Only the first case used to be considered, so a file that named a manager and
 * someone reporting to them failed the report with "Onboard the manager first"
 * — about a person two rows above. An email belonging to the file's own roster
 * is now carried forward and resolved once everyone has been admitted.
 */
function resolveReportingManager(
  source: BulkOnboardEmployeeRow,
  managerByEmail: ReadonlyMap<string, string>,
  roster: ReadonlySet<string>,
): ResolvedManager | { error: string } {
  if (source.reportingManagerUserId)
    return { reportingManagerUserId: source.reportingManagerUserId, reportingManagerEmail: null };
  if (!source.reportingManagerEmail)
    return { reportingManagerUserId: null, reportingManagerEmail: null };

  const managerEmail = canonicalAdmissionEmail(source.reportingManagerEmail);
  const managerUserId = managerByEmail.get(managerEmail);
  if (managerUserId) return { reportingManagerUserId: managerUserId, reportingManagerEmail: null };

  if (roster.has(managerEmail))
    return { reportingManagerUserId: null, reportingManagerEmail: managerEmail };

  return {
    error: `Reporting manager "${source.reportingManagerEmail}" is neither an active member of this organization nor a row of this file. Add them to the file, or onboard them first.`,
  };
}

export function planBulkOnboarding(
  rows: readonly BulkOnboardEmployeeRow[],
  catalog: DepartmentCatalog,
  screens: ReadonlyMap<string, AdmissionScreen>,
  employeeNumberOwner: ReadonlyMap<string, string | null>,
  roleErrors: Map<string, string>,
  globallyInactiveUserIds: ReadonlySet<string>,
  managerByEmail: ReadonlyMap<string, string>,
): BulkOnboardPlan {
  // The file's own roster, so a manager introduced by this upload resolves.
  const roster = rosterEmailsOf(rows);
  const plan: BulkOnboardPlan = { accepted: [], rejected: [] };
  const claimedNumbers = new Map(
    [...employeeNumberOwner].map(([employeeNumber, owner]) => [
      employeeNumber,
      owner ?? `persisted:${employeeNumber}`,
    ]),
  );
  const plannedEmails = new Set<string>();

  for (let index = 0; index < rows.length; index += 1) {
    const source = rows[index];
    const row = index + 1;
    const email = canonicalAdmissionEmail(source.email);

    const role = source.role || ORG_MEMBER_ROLES.MEMBER;
    const roleError = roleErrors.get(role);
    if (roleError) {
      plan.rejected.push({ row, email, success: false, error: roleError });
      continue;
    }

    const department = resolveDepartment(source, catalog);
    if ("error" in department) {
      plan.rejected.push({ row, email, success: false, error: department.error });
      continue;
    }

    const manager = resolveReportingManager(source, managerByEmail, roster);
    if ("error" in manager) {
      plan.rejected.push({ row, email, success: false, error: manager.error });
      continue;
    }

    const screen = screens.get(email);
    if (!screen) {
      plan.rejected.push({
        row,
        email,
        success: false,
        error: "This email could not be checked against the organization's admission rules.",
      });
      continue;
    }
    if (screen.kind !== "clear") {
      plan.rejected.push({ row, email, success: false, error: admissionRefusalMessage(screen) });
      continue;
    }

    if (screen.userId !== null && globallyInactiveUserIds.has(screen.userId)) {
      plan.rejected.push({
        row,
        email,
        success: false,
        error: "This account is globally suspended. Contact platform support to restore it before adding to an organization.",
      });
      continue;
    }

    // V-031. The row schema deliberately does not refine this. Validating it in
    // the array schema meant ONE under-16 date of birth 400'd the whole upload
    // and created nobody; here it is one row's reason beside the employee-ID
    // check, and the other 99 rows are still onboarded.
    const dobProblem = dateOfBirthProblem(source.dateOfBirth);
    if (dobProblem !== null) {
      plan.rejected.push({ row, email, success: false, error: dobProblem });
      continue;
    }

    const existingUserId = screen.userId ?? undefined;
    const requestedNumber = source.employeeId?.trim();
    const numberClaimant = existingUserId ?? `email:${email}`;
    const repeatedPlannedEmail = plannedEmails.has(email);
    if (requestedNumber && !repeatedPlannedEmail) {
      const claimant = claimedNumbers.get(requestedNumber);
      if (claimant !== undefined && claimant !== numberClaimant) {
        plan.rejected.push({
          row,
          email,
          success: false,
          error: `Employee ID "${requestedNumber}" is already in use in your organization.`,
        });
        continue;
      }
    }

    let employeeNumber = requestedNumber || `EMP-${randomEmployeeCode(6)}`;
    while (
      !requestedNumber &&
      !repeatedPlannedEmail &&
      claimedNumbers.has(employeeNumber)
    )
      employeeNumber = `EMP-${randomEmployeeCode(6)}`;
    if (!repeatedPlannedEmail)
      claimedNumbers.set(employeeNumber, numberClaimant);

    plan.accepted.push({
      row,
      email,
      source,
      clearance: screen,
      role,
      departmentId: department.departmentId,
      employeeNumber,
      firstName: source.firstName.trim(),
      lastName: source.lastName.trim(),
      designation: source.designation.trim(),
      joiningDate: source.joiningDate ? formatDateOnly(source.joiningDate) : null,
      dateOfBirth: source.dateOfBirth ? formatDateOnly(source.dateOfBirth) : null,
      reportingManagerUserId: manager.reportingManagerUserId,
      reportingManagerEmail: manager.reportingManagerEmail,
    });
    plannedEmails.add(email);
  }

  return rejectCyclesAndOrphans(plan);
}

/**
 * Two failures that only exist once a manager may come from the same file.
 *
 * A cycle — A reports to B reports to A — would otherwise be accepted and then
 * written as two reporting lines that make the org chart unreadable. And a row
 * pointing at a manager row the plan already rejected has to fail too, citing
 * that row: admitting it would create someone whose manager was never created,
 * and the operator would have no way to see the connection between the two
 * failures.
 */
function rejectCyclesAndOrphans(plan: BulkOnboardPlan): BulkOnboardPlan {
  const acceptedEmails = new Set(plan.accepted.map((employee) => employee.email));
  const rejectedRowOfEmail = new Map(plan.rejected.map((entry) => [entry.email, entry.row]));

  const edges: ManagerEdge[] = plan.accepted
    .filter((employee) => employee.reportingManagerEmail !== null)
    .map((employee) => ({
      row: employee.row,
      email: employee.email,
      managerEmail: employee.reportingManagerEmail ?? "",
    }));

  const failedRows = new Map<number, string>();

  for (const cycle of findManagerCycles(edges))
    failedRows.set(
      cycle.row,
      `Reporting chain loops back on itself: ${cycle.chain.join(" reports to ")}. Break the loop and upload again.`,
    );

  for (const employee of plan.accepted) {
    const managerEmail = employee.reportingManagerEmail;
    if (managerEmail === null || acceptedEmails.has(managerEmail)) continue;
    const managerRow = rejectedRowOfEmail.get(managerEmail);
    failedRows.set(
      employee.row,
      managerRow === undefined
        ? `Reporting manager "${managerEmail}" could not be onboarded, so this row was not created either.`
        : `Reporting manager "${managerEmail}" failed on row ${managerRow}, so this row was not created either.`,
    );
  }

  if (failedRows.size === 0) return plan;

  const kept = plan.accepted.filter((employee) => !failedRows.has(employee.row));
  const newlyRejected = plan.accepted
    .filter((employee) => failedRows.has(employee.row))
    .map((employee) => ({
      row: employee.row,
      email: employee.email,
      success: false,
      error: failedRows.get(employee.row) ?? "This row could not be created.",
    }));

  // A row rejected here may itself have been somebody's manager, so the sweep
  // repeats until nothing new falls out.
  const next: BulkOnboardPlan = {
    accepted: kept,
    rejected: [...plan.rejected, ...newlyRejected].sort((a, b) => a.row - b.row),
  };
  return newlyRejected.length > 0 ? rejectCyclesAndOrphans(next) : next;
}
