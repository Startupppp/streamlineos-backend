import {
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { addDays } from "date-fns";
import {
  hrEmployeeSensitiveFields,
  hrEmployments,
  hrPeople,
  magicLinkTokens,
  users,
} from "../../../db/schema";
import { hashToken } from "../../../common/security/token.util";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import { logger } from "../../../common/logger/logger.service";
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
import { ORG_MEMBER_ROLES } from "../../../common/rbac/org-roles";
import { assertMayGrantRole } from "../../../common/rbac/assert-may-grant-role";
import { AccessService } from "../../access/access.service";
import { syncOrgUnitPlacement } from "../../../common/org/sync-org-unit-placement";
import {
  liveEmployment,
  livePersonOfEmployment,
} from "../../directory/employment-query";
import { withMembershipMutations } from "../../../common/org/membership-mutations";
import {
  MembershipAdmissionService,
  admissionFailure,
} from "../../organization/core/membership-admission.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

const EMP_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

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

    const admitted = await withMembershipMutations(this.cache, (membership) =>
      runInTenantTransaction(
        this.db,
        async (tx) => {
          const outcome = await this.admission.admitOne(tx, {
            orgId: actor.orgId,
            email: body.email,
            role,
            actor,
            membership,
            seatReason: "employee onboarded",
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
          if (outcome.kind !== "admitted") throw admissionFailure(outcome);

          if (body.employeeId?.trim()) {
            const [duplicate] = await tx
              .select({ userId: hrPeople.userId })
              .from(hrEmployments)
              .innerJoin(hrPeople, livePersonOfEmployment(actor.orgId))
              .where(
                and(
                  liveEmployment(actor.orgId),
                  eq(hrEmployments.isPrimary, true),
                  eq(hrEmployments.employeeNumber, resolvedEmployeeId),
                ),
              )
              .limit(1);
            if (duplicate && duplicate.userId !== outcome.userId)
              throw new ConflictException(
                `Employee ID "${resolvedEmployeeId}" is already in use in your organization.`,
              );
          }

          if (!outcome.createdUser)
            await tx
              .update(users)
              .set({ dateOfBirth, isActive: true })
              .where(eq(users.id, outcome.userId));

          await syncOrgUnitPlacement(tx, actor.orgId, outcome.userId, {
            DEPARTMENT: body.departmentId,
          });

          if (body.monthlySalary && body.monthlySalary > 0)
            await seedEmployeeSalaryProfile(tx, {
              orgId: actor.orgId,
              userId: outcome.userId,
              actorId: actor.userId,
              monthlySalary: body.monthlySalary,
              effectiveFrom: joiningDate ?? formatDateOnly(new Date()),
              salaryStructureTemplateId: body.salaryStructureTemplateId,
            });

          return outcome;
        },
        { orgId: actor.orgId },
      ),
    );

    await this.invalidateHrDashboardCache(actor.orgId);

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
        ...(admitted.createdUser ? {} : { linked: true }),
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
      if (body.monthlySalary !== undefined) {
        sensitiveSet.salaryAmountCents = monthlyAmountToCents(body.monthlySalary);
        sensitiveSet.salaryCurrency = "INR";
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

    if (admitted.createdUser) {
      try {
        const rawToken = randomBytes(32).toString("hex");
        await this.db.insert(magicLinkTokens).values({
          id: randomUUID(),
          userId: admitted.userId,
          tokenHash: hashToken(rawToken),
          expiresAt: addDays(new Date(), 7),
        });
        const signInUrl = `${appUrl()}/magic-link?token=${rawToken}`;
        await this.email.sendWelcomeEmail(body.email, fullName, signInUrl);
      } catch (emailErr) {
        logger.error("Failed to send welcome email", { email: body.email, error: emailErr });
      }
    }

    return { success: true, userId: admitted.userId };
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
