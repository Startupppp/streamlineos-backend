import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { addDays } from "date-fns";
import {
  hrEmployeeSensitiveFields,
  hrEmployments,
  hrPeople,
  magicLinkTokens,
  organizationMembers,
  organizations,
  users,
} from "../../../db/schema";
import { hashToken } from "../../../common/security/token.util";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { EmailService } from "../../email/email.service";
import { appUrl } from "../../email/app-url";
import { AutomationService } from "../../automation/automation.service";
import { WebhooksDispatchService } from "../../webhooks/webhooks-dispatch.service";
import { PersonEmploymentSyncService } from "../core/person-employment-sync.service";
import { toBankDetails } from "./bulk-onboarding/bulk-onboarding-bank-details";
import { syncCanonicalEmploymentFields } from "../../../common/hr/sync-canonical-employment-fields";
import { sealSensitive } from "../../../common/security/sensitive-field";
import { sealBankDetails } from "../../../common/hr/canonical-bank-details";
import { monthlyAmountToCents } from "../../../common/hr/sync-canonical-sensitive-fields";
import { formatDateOnly } from "../../../common/date";
import { seedEmployeeSalaryProfile } from "./salary-profile-seed.helper";
import type { OnboardEmployeeInput } from "./dto/hr-directory.schemas";
import type { InviteDelivery } from "./dto/directory-response.schemas";
import { ORG_MEMBER_ROLES } from "../../../common/rbac/org-roles";
import { assertMayGrantRole } from "../../../common/rbac/assert-may-grant-role";
import { AccessService } from "../../access/access.service";
import { syncOrgUnitPlacement } from "../../../common/org/sync-org-unit-placement";
import {
  withMembershipMutations,
  type MembershipMutations,
} from "../../../common/org/membership-mutations";
import {
  MembershipAdmissionService,
  admissionFailure,
  canonicalAdmissionEmail,
  type AdmissionUserDraft,
} from "../../organization/core/membership-admission.service";
import {
  ALREADY_EMPLOYEE_MESSAGE,
  ATTACH_CONFIRMATION_REQUIRED_MESSAGE,
  findLivePrimaryEmploymentId,
} from "./employee-admission-status";
import { resolveOrgSalaryCurrency } from "./employment-salary-currency";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

const EMP_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const INVITE_TOKEN_DAYS = 7;

export const EMPLOYEE_NOT_FOUND_MESSAGE = "Employee not found in this organization.";

export const SUSPENDED_ACCOUNT_MESSAGE =
  "This account is globally suspended. Contact platform support to restore it before adding to an organization.";

export function alreadyMemberInviteReason(organizationName: string): string {
  return `Already a member of ${organizationName}, so no invitation was needed.`;
}

type InviteKind = "welcome" | "membership-added";

function randomEmployeeCode(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += EMP_CODE_ALPHABET[bytes[i] % EMP_CODE_ALPHABET.length];
  return out;
}

@Injectable()
export class EmployeeOnboardingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly automation: AutomationService,
    private readonly webhooks: WebhooksDispatchService,
    private readonly personEmploymentSync: PersonEmploymentSyncService,
    private readonly access: AccessService,
    private readonly admission: MembershipAdmissionService,
  ) {}

  async onboardEmployee(actor: CurrentUserContext, body: OnboardEmployeeInput) {
    const resolvedEmployeeId = body.employeeId?.trim() || `EMP-${randomEmployeeCode(6)}`;
    const role = body.role || ORG_MEMBER_ROLES.MEMBER;
    await assertMayGrantRole(this.access, actor.orgId, actor, role);

    const dateOfBirth = body.dateOfBirth ? formatDateOnly(body.dateOfBirth) : undefined;
    const joiningDate = body.joiningDate ? formatDateOnly(body.joiningDate) : null;
    const fullName = `${body.firstName} ${body.lastName}`;

    const salaryCurrency =
      body.monthlySalary === undefined
        ? null
        : await resolveOrgSalaryCurrency(this.db, actor.orgId);

    const admitted = await withMembershipMutations(this.cache, (membership) =>
      runInTenantTransaction(
        this.db,
        async (tx) => {
          const outcome = await this.resolveSubject(tx, {
            orgId: actor.orgId,
            email: body.email,
            role,
            actor,
            membership,
            attachToExistingMember: body.attachToExistingMember === true,
            createUserIfMissing: {
              name: fullName,
              firstName: body.firstName,
              lastName: body.lastName,
              phone: body.phone,
              whatsappNumber: body.whatsappSameAsPhone
                ? body.phone
                : body.whatsappNumber,
              gender: body.gender,
              dateOfBirth,
              isActive: true,
            },
          });

          if (!outcome.createdUser) {
            const [account] = await tx
              .select({ isActive: users.isActive })
              .from(users)
              .where(eq(users.id, outcome.userId))
              .limit(1);
            if (account?.isActive === false) throw new BadRequestException(SUSPENDED_ACCOUNT_MESSAGE);
          }

          if (body.employeeId?.trim()) {
            const [duplicate] = await tx
              .select({ userId: hrPeople.userId })
              .from(hrEmployments)
              .innerJoin(
                hrPeople,
                and(eq(hrPeople.orgId, actor.orgId), eq(hrPeople.id, hrEmployments.personId)),
              )
              .where(
                and(
                  eq(hrEmployments.orgId, actor.orgId),
                  eq(hrEmployments.employeeNumber, resolvedEmployeeId),
                ),
              )
              .limit(1);
            if (duplicate && duplicate.userId !== outcome.userId)
              throw new ConflictException(
                `Employee ID "${resolvedEmployeeId}" is already in use in your organization.`,
              );
          }

          await syncOrgUnitPlacement(tx, actor.orgId, outcome.userId, {
            DEPARTMENT: body.departmentId,
          });

          if (body.monthlySalary && body.monthlySalary > 0 && salaryCurrency)
            await seedEmployeeSalaryProfile(tx, {
              orgId: actor.orgId,
              userId: outcome.userId,
              actorId: actor.userId,
              monthlySalary: body.monthlySalary,
              currency: salaryCurrency,
              effectiveFrom: joiningDate ?? formatDateOnly(new Date()),
              salaryStructureTemplateId: body.salaryStructureTemplateId,
            });

          return outcome;
        },
        { orgId: actor.orgId },
      ),
    );

    void this.automation
      .runAutomationsForEvent(actor.orgId, "onboarding.started", {
        userId: admitted.userId,
        employeeName: fullName.trim(),
        employeeEmail: body.email,
        departmentId: body.departmentId ?? null,
        joiningDate: body.joiningDate ?? null,
        startedAt: new Date().toISOString(),
      })
      .catch(() => undefined);

    if (admitted.createdUser)
      this.webhooks.dispatch(actor.orgId, "employee.hired", {
        userId: admitted.userId,
        email: body.email,
        firstName: body.firstName,
        lastName: body.lastName,
        joiningDate: body.joiningDate ?? null,
      });

    const organizationName = await this.organizationName(actor.orgId);
    const invite: InviteDelivery = admitted.attached
      ? { sent: false, reason: alreadyMemberInviteReason(organizationName) }
      : await this.queueInvite({
          orgId: actor.orgId,
          organizationName,
          userId: admitted.userId,
          email: body.email,
          name: fullName.trim(),
          kind: admitted.createdUser ? "welcome" : "membership-added",
        });

    await this.audit.logCritical({
      action: "hr.employee_onboarded",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: admitted.userId,
      targetType: "employee",
      metadata: {
        email: body.email,
        name: fullName,
        role: body.role,
        designation: body.designation,
        invite,
        ...(admitted.createdUser ? {} : { linked: true }),
        ...(admitted.attached ? { attachedToExistingMember: true } : {}),
      },
    });

    const ensured = await this.personEmploymentSync.ensureFromUser(actor.orgId, actor.userId, {
      userId: admitted.userId,
      firstName: body.firstName,
      lastName: body.lastName,
      workEmail: body.email,
      employeeNumber: resolvedEmployeeId,
      joiningDate,
      designation: body.designation ?? null,
      phone: body.phone ?? null,
      lifecycleStatus: "ONBOARDING",
    });

    if (body.departmentId) {
      await syncCanonicalEmploymentFields(this.db, actor.orgId, admitted.userId, {
        departmentId: body.departmentId,
      });
    }

    if (body.taxId || body.bankDetails?.accountNumber || body.monthlySalary !== undefined) {
      const sensitiveSet: Partial<typeof hrEmployeeSensitiveFields.$inferInsert> = {};
      if (body.monthlySalary !== undefined && salaryCurrency) {
        sensitiveSet.salaryAmountCents = monthlyAmountToCents(body.monthlySalary);
        sensitiveSet.salaryCurrency = salaryCurrency;
        sensitiveSet.salaryFrequency = "MONTHLY";
      }
      if (body.taxId) sensitiveSet.taxId = sealSensitive(body.taxId);
      if (body.bankDetails?.accountNumber)
        sensitiveSet.bankDetails = sealBankDetails(toBankDetails(body.bankDetails));

      await this.db
        .insert(hrEmployeeSensitiveFields)
        .values({ orgId: actor.orgId, employmentId: ensured.employmentId, ...sensitiveSet })
        .onConflictDoUpdate({
          target: hrEmployeeSensitiveFields.employmentId,
          set: { ...sensitiveSet, updatedAt: new Date() },
        });
    }

    const orgId = actor.orgId;
    const afterCommitWork = (): Promise<void> => this.invalidateHrDashboardCache(orgId);
    if (!registerAfterCommit(afterCommitWork)) void afterCommitWork();

    return { success: true, userId: admitted.userId, invite };
  }

  async resendInvite(
    actor: CurrentUserContext,
    employeeUserId: string,
  ): Promise<{ success: true; invite: InviteDelivery }> {
    const [target] = await this.db
      .select({
        email: users.email,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        isActive: users.isActive,
        emailVerified: users.emailVerified,
        membershipStatus: organizationMembers.status,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(organizationMembers.orgId, actor.orgId),
          eq(organizationMembers.userId, employeeUserId),
        ),
      )
      .limit(1);
    if (!target || target.membershipStatus !== "ACTIVE")
      throw new NotFoundException(EMPLOYEE_NOT_FOUND_MESSAGE);
    if (!target.isActive) throw new BadRequestException(SUSPENDED_ACCOUNT_MESSAGE);

    const name =
      target.firstName && target.lastName
        ? `${target.firstName} ${target.lastName}`
        : (target.name ?? target.email);
    const invite = await this.queueInvite({
      orgId: actor.orgId,
      organizationName: await this.organizationName(actor.orgId),
      userId: employeeUserId,
      email: target.email,
      name,
      kind: target.emailVerified === null ? "welcome" : "membership-added",
    });

    await this.audit.logCritical({
      action: "hr.employee_invite_resent",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: employeeUserId,
      targetType: "employee",
      metadata: { email: target.email, invite },
    });

    return { success: true, invite };
  }

  private async organizationName(orgId: string): Promise<string> {
    const [org] = await this.db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw new NotFoundException("Organization not found.");
    return org.name;
  }

  private async queueInvite(input: {
    orgId: string;
    organizationName: string;
    userId: string;
    email: string;
    name: string;
    kind: InviteKind;
  }): Promise<InviteDelivery> {
    const rawToken = randomBytes(32).toString("hex");
    const tokenId = randomUUID();
    await this.db.insert(magicLinkTokens).values({
      id: tokenId,
      userId: input.userId,
      tokenHash: hashToken(rawToken),
      expiresAt: addDays(new Date(), INVITE_TOKEN_DAYS),
    });
    const signInUrl = `${appUrl()}/magic-link?token=${rawToken}`;

    const outcome =
      input.kind === "welcome"
        ? await this.email.queueWelcomeEmail({
            organizationId: input.orgId,
            recipientUserId: input.userId,
            email: input.email,
            name: input.name,
            setupUrl: signInUrl,
          })
        : await this.email.queueMembershipAddedEmail({
            organizationId: input.orgId,
            recipientUserId: input.userId,
            email: input.email,
            name: input.name,
            organizationName: input.organizationName,
            signInUrl,
          });
    if (outcome.queued) return { sent: true, reason: null };

    await this.db
      .update(magicLinkTokens)
      .set({ usedAt: new Date() })
      .where(eq(magicLinkTokens.id, tokenId));
    return { sent: false, reason: outcome.reason };
  }

  private async resolveSubject(
    tx: Db,
    input: {
      orgId: string;
      email: string;
      role: string;
      actor: CurrentUserContext;
      membership: MembershipMutations;
      attachToExistingMember: boolean;
      createUserIfMissing: AdmissionUserDraft;
    },
  ): Promise<{ userId: string; createdUser: boolean; attached: boolean }> {
    const email = canonicalAdmissionEmail(input.email);
    const screen = await this.admission.screen(tx, { orgId: input.orgId, email });

    if (screen.kind === "conflict" && screen.reason === "already-member") {
      const existingUserId = screen.userId;
      if (existingUserId === undefined) throw admissionFailure(screen);
      if (!input.attachToExistingMember)
        throw new ConflictException(ATTACH_CONFIRMATION_REQUIRED_MESSAGE);
      const employmentId = await findLivePrimaryEmploymentId(tx, input.orgId, existingUserId);
      if (employmentId !== null) throw new ConflictException(ALREADY_EMPLOYEE_MESSAGE);
      return { userId: existingUserId, createdUser: false, attached: true };
    }

    const [outcome] = await this.admission.admitMany(tx, {
      orgId: input.orgId,
      actor: input.actor,
      membership: input.membership,
      seatReason: "employee onboarded",
      candidates: [
        {
          email,
          role: input.role,
          screen,
          createUserIfMissing: input.createUserIfMissing,
        },
      ],
    });
    if (!outcome) throw new InternalServerErrorException(`Admission did not complete for ${email}.`);
    if (outcome.kind !== "admitted") throw admissionFailure(outcome);
    return { userId: outcome.userId, createdUser: outcome.createdUser, attached: false };
  }

  private async invalidateHrDashboardCache(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidateNamespaceForOrg(orgId, "hr:analytics"),
      this.cache.invalidate(`hr:dashboard:metrics:${orgId}`),
      this.cache.invalidate(`hr:dashboard:headcount-trends:${orgId}`),
      this.cache.invalidateNamespaceForOrg(orgId, "hr:celebrations"),
      this.cache.invalidateNamespace(CACHE_KEYS.hrEmployeesListNamespace(orgId)),
    ]);
  }
}
