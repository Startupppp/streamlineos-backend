import { and, eq, inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { hrEmployments, hrPeople } from "../../../../db/schema";
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
import type { BulkOnboardEmployeeRow } from "../dto/hr-directory.schemas";
import type { DepartmentCatalog } from "./bulk-onboarding-departments";
import type { BulkOnboardPlan } from "./bulk-onboarding.types";

const EMP_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomEmployeeCode(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += EMP_CODE_ALPHABET[bytes[i] % EMP_CODE_ALPHABET.length];
  return out;
}

/** Who already holds each requested employee number, as one org-scoped query for the whole upload. */
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

// Decides every row from the preloaded maps alone, so a rejected row costs no query and still reports why.
export function planBulkOnboarding(
  rows: readonly BulkOnboardEmployeeRow[],
  catalog: DepartmentCatalog,
  screens: ReadonlyMap<string, AdmissionScreen>,
  employeeNumberOwner: ReadonlyMap<string, string | null>,
  roleErrors: Map<string, string>,
): BulkOnboardPlan {
  const plan: BulkOnboardPlan = { accepted: [], rejected: [] };
  const seenEmails = new Set<string>();
  const claimedNumbers = new Set(employeeNumberOwner.keys());

  for (let index = 0; index < rows.length; index += 1) {
    const source = rows[index];
    const row = index + 1;
    const email = canonicalAdmissionEmail(source.email);

    if (seenEmails.has(email)) {
      plan.rejected.push({ row, email, success: false, error: "Duplicate email in this upload" });
      continue;
    }
    seenEmails.add(email);

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

    const existingUserId = screen.userId ?? undefined;
    const requestedNumber = source.employeeId?.trim();
    if (requestedNumber) {
      const owner = employeeNumberOwner.get(requestedNumber);
      if (owner !== undefined && owner !== existingUserId) {
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
    while (!requestedNumber && claimedNumbers.has(employeeNumber))
      employeeNumber = `EMP-${randomEmployeeCode(6)}`;
    claimedNumbers.add(employeeNumber);

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
    });
  }

  return plan;
}
