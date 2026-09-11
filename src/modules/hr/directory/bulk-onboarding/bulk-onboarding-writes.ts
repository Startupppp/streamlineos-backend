import { InternalServerErrorException } from "@nestjs/common";
import { inArray, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { addDays } from "date-fns";
import {
  hrEmployeeSensitiveFields,
  magicLinkTokens,
  orgUnitMembers,
  users,
} from "../../../../db/schema";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";
import { hashToken } from "../../../../common/security/token.util";
import type { MembershipMutations } from "../../../../common/org/membership-mutations";
import { sealSensitive } from "../../../../common/security/sensitive-field";
import { sealBankDetails } from "../../../../common/hr/canonical-bank-details";
import { monthlyAmountToCents } from "../../../../common/hr/sync-canonical-sensitive-fields";
import { formatDateOnly } from "../../../../common/date";
import { appUrl } from "../../../email/app-url";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { PersonEmploymentSyncService } from "../../core/person-employment-sync.service";
import {
  admissionRefusalMessage,
  type MembershipAdmissionService,
} from "../../../organization/core/membership-admission.service";
import { toBankDetails } from "./bulk-onboarding-bank-details";
import { seedSalaryProfiles, type SalarySeedEntry } from "./bulk-onboarding-salary";
import type {
  AdmittedEmployee,
  BulkOnboardWriteOutcome,
  PlannedEmployee,
} from "./bulk-onboarding.types";

export interface BulkOnboardWriteDeps {
  admission: MembershipAdmissionService;
  personEmploymentSync: PersonEmploymentSyncService;
  membership: MembershipMutations;
}

/** Accounts that already existed are re-activated here; brand-new accounts are written by admission. */
async function refreshRelinkedUsers(
  tx: DbOrTx,
  admitted: readonly AdmittedEmployee[],
): Promise<void> {
  const relinked = admitted.filter((employee) => !employee.createdUser);
  if (relinked.length === 0) return;

  await tx
    .update(users)
    .set({ isActive: true })
    .where(inArray(users.id, relinked.map((employee) => employee.userId)));

  const withBirthday = relinked.filter((employee) => employee.dateOfBirth !== null);
  if (withBirthday.length === 0) return;
  const pairs = sql.join(
    withBirthday.map((employee) => sql`(${employee.userId}::text, ${employee.dateOfBirth}::date)`),
    sql`, `,
  );
  await tx.execute(
    sql`UPDATE users AS u SET date_of_birth = v.date_of_birth FROM (VALUES ${pairs}) AS v(id, date_of_birth) WHERE u.id = v.id`,
  );
}

async function writeSensitiveFields(
  tx: DbOrTx,
  orgId: string,
  admitted: readonly AdmittedEmployee[],
  employmentIdByUserId: Map<string, number>,
): Promise<void> {
  const rows: Array<typeof hrEmployeeSensitiveFields.$inferInsert> = [];
  for (const employee of admitted) {
    const { taxId, bankDetails, monthlySalary } = employee.source;
    if (!taxId && !bankDetails?.accountNumber && monthlySalary === undefined) continue;
    const employmentId = employmentIdByUserId.get(employee.userId);
    if (employmentId === undefined) continue;
    rows.push({
      orgId,
      employmentId,
      ...(monthlySalary === undefined
        ? {}
        : {
            salaryAmountCents: monthlyAmountToCents(monthlySalary),
            salaryCurrency: "INR",
            salaryFrequency: "MONTHLY",
          }),
      ...(taxId ? { taxId: sealSensitive(taxId) } : {}),
      ...(bankDetails?.accountNumber
        ? { bankDetails: sealBankDetails(toBankDetails(bankDetails)) }
        : {}),
    });
  }
  if (rows.length === 0) return;

  await tx
    .insert(hrEmployeeSensitiveFields)
    .values(rows)
    .onConflictDoUpdate({
      target: hrEmployeeSensitiveFields.employmentId,
      set: {
        salaryAmountCents: sql`coalesce(excluded.salary_amount_cents, ${hrEmployeeSensitiveFields.salaryAmountCents})`,
        salaryCurrency: sql`coalesce(excluded.salary_currency, ${hrEmployeeSensitiveFields.salaryCurrency})`,
        salaryFrequency: sql`coalesce(excluded.salary_frequency, ${hrEmployeeSensitiveFields.salaryFrequency})`,
        taxId: sql`coalesce(excluded.tax_id, ${hrEmployeeSensitiveFields.taxId})`,
        bankDetails: sql`coalesce(excluded.bank_details, ${hrEmployeeSensitiveFields.bankDetails})`,
        updatedAt: new Date(),
      },
    });
}

// Admission locks the quota and asserts it once for the whole batch, keeping the seat ceiling a serialized write invariant.
export async function writeBulkOnboarding(
  tx: DbOrTx,
  actor: CurrentUserContext,
  accepted: readonly PlannedEmployee[],
  deps: BulkOnboardWriteDeps,
): Promise<BulkOnboardWriteOutcome> {
  const orgId = actor.orgId;

  const outcomes = await deps.admission.admitMany(tx, {
    orgId,
    actor,
    membership: deps.membership,
    seatReason: "employee onboarded",
    candidates: accepted.map((employee) => ({
      email: employee.email,
      role: employee.role,
      screen: employee.clearance,
      createUserIfMissing: {
        name: `${employee.firstName} ${employee.lastName}`,
        firstName: employee.firstName,
        lastName: employee.lastName,
        phone: employee.source.phone,
        whatsappNumber: employee.source.whatsappSameAsPhone
          ? employee.source.phone
          : employee.source.whatsappNumber,
        gender: employee.source.gender,
        dateOfBirth: employee.dateOfBirth ?? undefined,
        isActive: true,
      },
    })),
  });

  const admitted: AdmittedEmployee[] = [];
  const rejected: BulkOnboardWriteOutcome["rejected"] = [];
  accepted.forEach((employee, index) => {
    const outcome = outcomes[index];
    if (!outcome)
      throw new InternalServerErrorException(
        `Admission did not complete for ${employee.email}.`,
      );
    if (outcome.kind !== "admitted") {
      rejected.push({
        row: employee.row,
        email: employee.email,
        success: false,
        error: admissionRefusalMessage(outcome),
      });
      return;
    }
    admitted.push({
      ...employee,
      userId: outcome.userId,
      membershipId: outcome.membershipId,
      createdUser: outcome.createdUser,
    });
  });

  await refreshRelinkedUsers(tx, admitted);

  const placements = admitted
    .filter((employee) => employee.departmentId !== null && employee.membershipId !== null)
    .map((employee) => ({
      id: randomUUID(),
      orgId,
      orgUnitId: employee.departmentId ?? "",
      membershipId: employee.membershipId ?? 0,
      role: "member",
    }));
  if (placements.length > 0)
    await tx.insert(orgUnitMembers).values(placements).onConflictDoNothing();

  const employments = await deps.personEmploymentSync.ensureManyFromUsers(
    orgId,
    actor.userId,
    admitted.map((employee) => ({
      userId: employee.userId,
      firstName: employee.firstName,
      lastName: employee.lastName,
      workEmail: employee.email,
      employeeNumber: employee.employeeNumber,
      joiningDate: employee.joiningDate,
      designation: employee.designation,
      phone: employee.source.phone ?? null,
      departmentId: employee.departmentId,
      lifecycleStatus: "ONBOARDING" as const,
    })),
    tx,
  );
  const employmentIdByUserId = new Map(
    employments.map((employment) => [employment.userId, employment.employmentId]),
  );

  await writeSensitiveFields(tx, orgId, admitted, employmentIdByUserId);

  const salarySeeds: SalarySeedEntry[] = admitted
    .filter((employee) => (employee.source.monthlySalary ?? 0) > 0)
    .map((employee) => ({
      userId: employee.userId,
      monthlySalary: employee.source.monthlySalary ?? 0,
      effectiveFrom: employee.joiningDate ?? formatDateOnly(new Date()),
      salaryStructureTemplateId: employee.source.salaryStructureTemplateId,
    }));
  await seedSalaryProfiles(tx, orgId, actor.userId, salarySeeds);

  const invitees = admitted.filter((employee) => employee.createdUser);
  const welcomeEmails: BulkOnboardWriteOutcome["welcomeEmails"] = [];
  if (invitees.length > 0) {
    const expiresAt = addDays(new Date(), 7);
    const tokens = invitees.map((employee) => {
      const rawToken = randomBytes(32).toString("hex");
      welcomeEmails.push({
        email: employee.email,
        name: `${employee.firstName} ${employee.lastName}`,
        signInUrl: `${appUrl()}/magic-link?token=${rawToken}`,
      });
      return {
        id: randomUUID(),
        userId: employee.userId,
        tokenHash: hashToken(rawToken),
        expiresAt,
      };
    });
    await tx.insert(magicLinkTokens).values(tokens);
  }

  return { admitted, rejected, welcomeEmails };
}
