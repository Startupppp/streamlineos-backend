import type { SubjectEmployment } from "../../../directory/reporting-line-queries";
import { evaluateRelationshipCommand } from "../../../directory/reporting-relationship-rules";
import {
  REPORTING_LINE_ERROR_CODES as CODES,
  type ManagerAssignmentCheck,
  type ReportingManagerPolicy,
} from "../../../directory/reporting-line.types";
import type { PersonRef } from "../reporting-manager-people";
import type { PlannedSecondaryManager } from "./bulk-onboarding.types";

export interface HireSecondaryInput {
  hire: { email: string; userId: string | null; topLevelReason: string | null; effectiveFrom: string };
  /** Null for a top-level row; `userId` null for a manager who is another row of this file. */
  primary: { userId: string | null; email: string | null } | null;
  secondaryEmails: readonly string[];
  /** Existing members of the organization, by canonical email. */
  people: ReadonlyMap<string, PersonRef>;
  /** Every canonical email of the file. */
  roster: ReadonlySet<string>;
  policy: ReportingManagerPolicy;
  managerChecks: ReadonlyMap<string, ManagerAssignmentCheck>;
  managerEmployments: ReadonlyMap<number, SubjectEmployment>;
}

export type HireSecondaryResult =
  | { ok: true; secondaries: PlannedSecondaryManager[] }
  | { ok: false; code: string; error: string };

/**
 * A hire's secondary managers, judged by the same `evaluateRelationshipCommand` every other writer
 * uses (cap, self, duplicate, duplicate of the primary, eligibility, employment window, top-level).
 * The hire and any manager who is another row of the file do not exist yet, so they stand in under
 * placeholder ids the rules treat as eligible; the only check kept here is the in-file one: an email
 * that is neither a member nor a row.
 */
export function checkHireSecondaries(input: HireSecondaryInput): HireSecondaryResult {
  const inFile = (email: string) => `in-file:${email}`;
  const subjectUserId = input.hire.userId ?? inFile(input.hire.email);
  const checks = new Map(input.managerChecks);
  let placeholderEmployment = -2;
  const idOf = (email: string): string => {
    if (email === input.hire.email) return subjectUserId;
    const person = input.people.get(email);
    if (person) return person.userId;
    const id = inFile(email);
    if (!checks.has(id)) checks.set(id, { ok: true, managerEmploymentId: placeholderEmployment-- });
    return id;
  };

  for (const email of input.secondaryEmails)
    if (email !== input.hire.email && !input.people.has(email) && !input.roster.has(email))
      return { ok: false, code: CODES.MANAGER_NOT_FOUND, error: `No member of this organization or row of this file has the email ${email}.` };

  const primaryUserId = input.primary === null ? null : input.primary.userId ?? idOf(input.primary.email ?? "");
  const subject: SubjectEmployment = { userId: subjectUserId, employmentId: -1, lifecycleStatus: "ACTIVE", joiningDate: null, lastWorkingDay: null, exitDate: null };
  const validation = evaluateRelationshipCommand(
    {
      orgId: input.policy.orgId,
      actor: { orgId: input.policy.orgId, system: "bulk-onboarding-preview" },
      subjectUserId,
      primaryManagerUserId: primaryUserId,
      topLevelReason: input.hire.topLevelReason,
      secondary: input.secondaryEmails.map((email) => ({ managerUserId: idOf(email) })),
      effectiveFrom: input.hire.effectiveFrom,
      source: "BULK_ONBOARDING",
    },
    {
      policy: input.policy,
      subject,
      managerChecks: checks,
      managerEmployments: input.managerEmployments,
      currentPrimary: null,
      currentSecondary: [],
      changesLast24h: 0,
      cyclic: false,
      elevated: false,
      system: true,
    },
  );
  const issue = validation.issues[0];
  if (issue) return { ok: false, code: issue.code, error: issue.message };
  return {
    ok: true,
    secondaries: input.secondaryEmails.map((email) => {
      const person = input.people.get(email);
      return { email, userId: person?.userId ?? null, name: person?.name ?? null };
    }),
  };
}
