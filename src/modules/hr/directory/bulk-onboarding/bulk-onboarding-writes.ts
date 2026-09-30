import { InternalServerErrorException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { addDays } from "date-fns";
import {
  hrEmployeeSensitiveFields,
  magicLinkTokens,
  orgUnitMembers,
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
import type { ReportingRelationshipService } from "../../../directory/reporting-relationship.service";
import { ReportingLineException } from "../../../directory/reporting-line-errors";
import { REPORTING_LINE_ERROR_CODES } from "../../../directory/reporting-line.types";
import {
  admissionRefusalMessage,
  type MembershipAdmissionService,
} from "../../../organization/core/membership-admission.service";
import { toBankDetails } from "./bulk-onboarding-bank-details";
import { resolveOrgSalaryCurrency } from "../employment-salary-currency";
import { seedSalaryProfiles, type SalarySeedEntry } from "./bulk-onboarding-salary";
import type {
  AdmittedEmployee,
  BulkOnboardWriteOutcome,
  PlannedEmployee,
} from "./bulk-onboarding.types";
import { managersFirst } from "./bulk-onboarding-graph";

export interface BulkOnboardWriteDeps {
  admission: MembershipAdmissionService;
  personEmploymentSync: PersonEmploymentSyncService;
  membership: MembershipMutations;
  relationships: Pick<ReportingRelationshipService, "setRelationships">;
  /** The organisation's business date, for rows with neither `effectiveFrom` nor a joining date. */
  today: string;
}

async function writeSensitiveFields(
  tx: DbOrTx,
  orgId: string,
  admitted: readonly AdmittedEmployee[],
  employmentIdByUserId: Map<string, number>,
  salaryCurrency: string | null,
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
      ...(monthlySalary === undefined || salaryCurrency === null
        ? {}
        : {
            salaryAmountCents: monthlyAmountToCents(monthlySalary),
            salaryCurrency,
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
      locationId: employee.locationId,
      workerType: employee.source.workerType,
      lifecycleStatus: "ONBOARDING" as const,
    })),
    tx,
  );
  const employmentIdByUserId = new Map(
    employments.map((employment) => [employment.userId, employment.employmentId]),
  );

  // A manager introduced by this same file has no user id until now, which is
  // why the plan carried the email instead. Relationships are written
  // managers-first, so a line's manager already has their own line, and every
  // write goes through the canonical relationship service (HRM-15): a refusal
  // here aborts the file, because the preview promised these rows.
  const userIdByEmail = new Map(admitted.map((employee) => [employee.email, employee.userId]));
  const byEmail = new Map(admitted.map((employee) => [employee.email, employee]));
  const managerOrder = managersFirst(
    admitted.map((employee) => employee.email),
    admitted
      .filter((employee) => employee.reportingManagerEmail !== null)
      .map((employee) => ({
        row: employee.row,
        email: employee.email,
        managerEmail: employee.reportingManagerEmail ?? "",
      })),
  );

  for (const email of managerOrder) {
    const employee = byEmail.get(email);
    if (!employee) continue;
    const effectiveFrom = employee.effectiveFrom ?? employee.joiningDate ?? deps.today;
    const secondary = employee.secondaryManagers.flatMap((manager) => {
      const managerUserId = manager.userId ?? userIdByEmail.get(manager.email);
      return managerUserId ? [{ managerUserId }] : [];
    });
    if (employee.primaryManager === null) {
      await deps.relationships.setRelationships(tx, {
        orgId,
        actor,
        subjectUserId: employee.userId,
        primaryManagerUserId: null,
        topLevelReason: employee.source.topLevelRoleReason ?? null,
        effectiveFrom,
        source: "BULK_ONBOARDING",
      });
      continue;
    }
    const managerUserId =
      employee.primaryManager.userId ??
      (employee.reportingManagerEmail === null ? null : (userIdByEmail.get(employee.reportingManagerEmail) ?? null));
    if (managerUserId === null)
      throw new ReportingLineException(
        REPORTING_LINE_ERROR_CODES.MANAGER_ROW_FAILED,
        `Row ${employee.row}: the reporting manager "${employee.reportingManagerEmail ?? ""}" was not created, so nothing was onboarded. Preview the file again.`,
        { row: employee.row },
      );
    const fallback = employee.primaryManager.resolution === "FALLBACK_CONFIGURED" || employee.primaryManager.resolution === "FALLBACK_UPLOADER";
    await deps.relationships.setRelationships(tx, {
      orgId,
      actor,
      subjectUserId: employee.userId,
      primaryManagerUserId: managerUserId,
      secondary: secondary.length > 0 ? secondary : undefined,
      effectiveFrom,
      source: fallback ? "ONBOARDING_FALLBACK" : "BULK_ONBOARDING",
      secondarySource: "BULK_ONBOARDING",
    });
    employee.primaryManager = { ...employee.primaryManager, userId: managerUserId };
  }

  const salaryCurrency = admitted.some(
    (employee) => employee.source.monthlySalary !== undefined,
  )
    ? await resolveOrgSalaryCurrency(tx, orgId)
    : null;

  await writeSensitiveFields(tx, orgId, admitted, employmentIdByUserId, salaryCurrency);

  const salarySeeds: SalarySeedEntry[] = admitted
    .filter((employee) => (employee.source.monthlySalary ?? 0) > 0)
    .map((employee) => ({
      userId: employee.userId,
      monthlySalary: employee.source.monthlySalary ?? 0,
      effectiveFrom: employee.joiningDate ?? formatDateOnly(new Date()),
      salaryStructureTemplateId: employee.source.salaryStructureTemplateId,
    }));
  if (salaryCurrency !== null)
    await seedSalaryProfiles(tx, orgId, actor.userId, salarySeeds, salaryCurrency);

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
        orgId,
        tokenHash: hashToken(rawToken),
        expiresAt,
      };
    });
    await tx.insert(magicLinkTokens).values(tokens);
  }

  return { admitted, rejected, welcomeEmails };
}
