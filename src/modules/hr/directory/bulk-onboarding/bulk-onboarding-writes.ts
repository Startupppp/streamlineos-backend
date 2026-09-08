import { and, eq, inArray, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { addDays } from "date-fns";
import {
  hrEmployeeSensitiveFields,
  magicLinkTokens,
  orgUnitMembers,
  organizationMembers,
  roleAssignments,
  roles,
  users,
} from "../../../../db/schema";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";
import { bumpPermissionsVersion } from "../../../../common/rbac/access-invalidate";
import { ORG_MEMBER_ROLES } from "../../../../common/rbac/org-roles";
import { hashToken } from "../../../../common/security/token.util";
import { sealSensitive } from "../../../../common/security/sensitive-field";
import { sealBankDetails } from "../../../../common/hr/canonical-bank-details";
import { monthlyAmountToCents } from "../../../../common/hr/sync-canonical-sensitive-fields";
import { formatDateOnly } from "../../../../common/date";
import { appUrl } from "../../../email/app-url";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { PlanLimitsService } from "../../../billing/core/plan-limits.service";
import type { SeatLedgerService } from "../../../billing/core/seat-ledger.service";
import type { PersonEmploymentSyncService } from "../../core/person-employment-sync.service";
import { lockMembersQuota } from "../../../billing/core/seat-definition";
import { toBankDetails } from "./bulk-onboarding-bank-details";
import { seedSalaryProfiles, type SalarySeedEntry } from "./bulk-onboarding-salary";
import type { BulkOnboardWriteOutcome, PlannedEmployee } from "./bulk-onboarding.types";

export interface BulkOnboardWriteDeps {
  planLimits: PlanLimitsService;
  seatLedger: SeatLedgerService;
  personEmploymentSync: PersonEmploymentSyncService;
}

async function insertUsers(tx: DbOrTx, accepted: readonly PlannedEmployee[]): Promise<void> {
  const created = accepted.filter((employee) => employee.isNewUser);
  if (created.length > 0)
    await tx.insert(users).values(
      created.map((employee) => ({
        id: employee.userId,
        email: employee.email,
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
      })),
    );

  const relinked = accepted.filter((employee) => !employee.isNewUser);
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

async function assignStructuralRoles(
  tx: DbOrTx,
  orgId: string,
  membershipIdByUserId: Map<string, number>,
  accepted: readonly PlannedEmployee[],
): Promise<void> {
  const structuralSlugs = [ORG_MEMBER_ROLES.ORG_ADMIN, ORG_MEMBER_ROLES.MEMBER];
  const roleRows = await tx
    .select({ id: roles.id, slug: roles.slug })
    .from(roles)
    .where(and(eq(roles.orgId, orgId), inArray(roles.slug, structuralSlugs)))
    .limit(structuralSlugs.length);
  const roleIdBySlug = new Map(roleRows.map((role) => [role.slug, role.id]));

  const assignments: Array<typeof roleAssignments.$inferInsert> = [];
  for (const employee of accepted) {
    const roleId = roleIdBySlug.get(employee.role);
    const membershipId = membershipIdByUserId.get(employee.userId);
    if (roleId === undefined || membershipId === undefined) continue;
    assignments.push({
      orgId,
      organizationMembershipId: membershipId,
      roleId,
      assignedByMembershipId: null,
    });
  }

  if (assignments.length > 0)
    await tx.insert(roleAssignments).values(assignments).onConflictDoNothing();
  await bumpPermissionsVersion(tx, orgId);
}

async function writeSensitiveFields(
  tx: DbOrTx,
  orgId: string,
  accepted: readonly PlannedEmployee[],
  employmentIdByUserId: Map<string, number>,
): Promise<void> {
  const rows: Array<typeof hrEmployeeSensitiveFields.$inferInsert> = [];
  for (const employee of accepted) {
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

// Quota is locked and asserted once for the whole batch, keeping the seat ceiling a serialized write invariant.
export async function writeBulkOnboarding(
  tx: DbOrTx,
  actor: CurrentUserContext,
  accepted: readonly PlannedEmployee[],
  deps: BulkOnboardWriteDeps,
): Promise<BulkOnboardWriteOutcome> {
  const orgId = actor.orgId;
  await tx.execute(lockMembersQuota(orgId));
  await deps.planLimits.assertWithinLimit(orgId, "members", accepted.length, tx);

  await insertUsers(tx, accepted);

  const memberships = await tx
    .insert(organizationMembers)
    .values(
      accepted.map((employee) => ({ orgId, userId: employee.userId, role: employee.role })),
    )
    .returning({ id: organizationMembers.id, userId: organizationMembers.userId });
  const membershipIdByUserId = new Map(
    memberships.map((membership) => [membership.userId, membership.id]),
  );

  await assignStructuralRoles(tx, orgId, membershipIdByUserId, accepted);

  const placements = accepted
    .filter((employee) => employee.departmentId !== null)
    .map((employee) => ({
      id: randomUUID(),
      orgId,
      orgUnitId: employee.departmentId ?? "",
      membershipId: membershipIdByUserId.get(employee.userId) ?? 0,
      role: "member",
    }))
    .filter((placement) => placement.membershipId !== 0);
  if (placements.length > 0)
    await tx.insert(orgUnitMembers).values(placements).onConflictDoNothing();

  await deps.seatLedger.recordSeatEvents(
    tx,
    orgId,
    accepted.map((employee) => ({
      eventType: "INVITE_ACCEPTED" as const,
      subjectId: employee.userId,
      actorId: actor.userId,
      reason: "employee onboarded",
      idempotencyKey: `member-added:${orgId}:${employee.userId}`,
    })),
  );

  const employments = await deps.personEmploymentSync.ensureManyFromUsers(
    orgId,
    actor.userId,
    accepted.map((employee) => ({
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

  await writeSensitiveFields(tx, orgId, accepted, employmentIdByUserId);

  const salarySeeds: SalarySeedEntry[] = accepted
    .filter((employee) => (employee.source.monthlySalary ?? 0) > 0)
    .map((employee) => ({
      userId: employee.userId,
      monthlySalary: employee.source.monthlySalary ?? 0,
      effectiveFrom: employee.joiningDate ?? formatDateOnly(new Date()),
      salaryStructureTemplateId: employee.source.salaryStructureTemplateId,
    }));
  await seedSalaryProfiles(tx, orgId, actor.userId, salarySeeds);

  const invitees = accepted.filter((employee) => employee.isNewUser);
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

  return { createdUserIds: accepted.map((employee) => employee.userId), welcomeEmails };
}
