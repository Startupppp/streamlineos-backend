import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { addDays } from "date-fns";
import {
  magicLinkTokens,
  organizationMembers,
  users,
} from "../../../db/schema";
import { hashToken } from "../../../common/security/token.util";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { logger } from "../../../common/logger/logger.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { EmailService } from "../../email/email.service";
import { appUrl } from "../../email/app-url";
import { AutomationService } from "../../automation/automation.service";
import { WebhooksDispatchService } from "../../webhooks/webhooks-dispatch.service";
import { PersonEmploymentSyncService } from "../core/person-employment-sync.service";
import { encrypt, encryptBankDetails, type BankDetails } from "../onboarding/core/crypto.helpers";
import { formatDateOnly } from "../../../common/date";
import { seedEmployeeSalaryProfile } from "./salary-profile-seed.helper";
import type { OnboardEmployeeInput, UpdateEmployeeInput } from "./dto/hr-directory.schemas";
import { ORG_MEMBER_ROLES } from "../../../common/rbac/org-roles";
import { syncStructuralRoleAssignment } from "../../../common/rbac/sync-structural-role";

type BankDetailsInput = NonNullable<UpdateEmployeeInput["bankDetails"]> & {
  pfUanNumber?: string;
  esiIpNumber?: string;
};

const EMP_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomEmployeeCode(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += EMP_CODE_ALPHABET[bytes[i] % EMP_CODE_ALPHABET.length];
  return out;
}

function toBankDetails(input: BankDetailsInput): BankDetails {
  return {
    accountNumber: input.accountNumber ?? "",
    bankName: input.bankName ?? "",
    branch: input.branch ?? "",
    ifsc: input.ifsc ?? "",
    accountHolder: input.accountHolder ?? "",
    ...(input.pfUanNumber !== undefined ? { pfUanNumber: input.pfUanNumber } : {}),
    ...(input.esiIpNumber !== undefined ? { esiIpNumber: input.esiIpNumber } : {}),
  };
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
  ) {}

  async onboardEmployee(actor: CurrentUserContext, body: OnboardEmployeeInput) {
    const existingUser = await this.db.query.users.findFirst({
      where: eq(users.email, body.email.toLowerCase()),
      columns: { id: true },
    });

    if (existingUser) {
      const alreadyMember = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, actor.orgId),
          eq(organizationMembers.userId, existingUser.id),
        ),
        columns: { userId: true },
      });
      if (alreadyMember) {
        throw new ConflictException("This email already belongs to an employee in your organization.");
      }
    }

    const resolvedEmployeeId = body.employeeId?.trim() || `EMP-${randomEmployeeCode(6)}`;

    if (body.employeeId?.trim()) {
      const [duplicate] = await this.db
        .select({ userId: users.id })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(
          and(
            eq(organizationMembers.orgId, actor.orgId),
            eq(users.employeeId, resolvedEmployeeId),
          ),
        )
        .limit(1);
      if (duplicate && duplicate.userId !== existingUser?.id) {
        throw new ConflictException(`Employee ID "${resolvedEmployeeId}" is already in use in your organization.`);
      }
    }

    const role = body.role || ORG_MEMBER_ROLES.MEMBER;

    if (existingUser) {
      const linkedUser = await this.db.transaction(async (tx) => {
        const updateData: Partial<typeof users.$inferInsert> = {
          designation: body.designation,
          orgDepartmentId: body.departmentId,
          role,
          employeeId: resolvedEmployeeId,
          joiningDate: body.joiningDate ? formatDateOnly(new Date(body.joiningDate)) : undefined,
          dateOfBirth: body.dateOfBirth ? formatDateOnly(new Date(body.dateOfBirth)) : undefined,
          isActive: true,
          hasDashboardAccess: true,
        };
        if (body.taxId) updateData.taxId = encrypt(body.taxId);
        if (body.monthlySalary !== undefined) updateData.monthlySalary = body.monthlySalary.toString();
        if (body.bankDetails?.accountNumber) {
          updateData.bankDetails = encryptBankDetails(toBankDetails(body.bankDetails));
        }

        await tx.update(users).set(updateData).where(eq(users.id, existingUser.id));
        const insertedMembership = await tx
          .insert(organizationMembers)
          .values({ orgId: actor.orgId, userId: existingUser.id, role })
          .returning({ id: organizationMembers.id });
        if (insertedMembership[0]) {
          await syncStructuralRoleAssignment(tx, actor.orgId, insertedMembership[0].id, role);
        }

        if (body.monthlySalary && body.monthlySalary > 0) {
          const effectiveFrom = body.joiningDate
            ? formatDateOnly(new Date(body.joiningDate))
            : formatDateOnly(new Date());
          await seedEmployeeSalaryProfile(tx, {
            orgId: actor.orgId,
            userId: existingUser.id,
            actorId: actor.userId,
            monthlySalary: body.monthlySalary,
            effectiveFrom,
          });
        }

        const updated = await tx.query.users.findFirst({
          where: eq(users.id, existingUser.id),
          columns: { id: true, email: true, firstName: true, lastName: true },
        });
        if (!updated) throw new InternalServerErrorException("Failed to link user record.");
        return updated;
      });

      await this.invalidateHrDashboardCache(actor.orgId);

      void this.automation
        .runAutomationsForEvent(actor.orgId, "onboarding.started", {
          userId: linkedUser.id,
          employeeName: `${linkedUser.firstName ?? ""} ${linkedUser.lastName ?? ""}`.trim(),
          employeeEmail: linkedUser.email,
          departmentId: body.departmentId ?? null,
          joiningDate: body.joiningDate ?? null,
          startedAt: new Date().toISOString(),
        })
        .catch(() => undefined);

      this.audit.log({
        action: "hr.employee_onboarded",
        userId: actor.userId,
        orgId: actor.orgId,
        targetId: linkedUser.id,
        targetType: "employee",
        metadata: {
          email: body.email,
          name: `${body.firstName} ${body.lastName}`,
          role: body.role,
          designation: body.designation,
          linked: true,
        },
      });

      await this.personEmploymentSync.ensureFromUser(actor.orgId, actor.userId, {
        userId: linkedUser.id,
        firstName: body.firstName,
        lastName: body.lastName,
        workEmail: body.email,
        employeeNumber: resolvedEmployeeId,
        joiningDate: body.joiningDate
          ? formatDateOnly(new Date(body.joiningDate))
          : null,
        designation: body.designation ?? null,
        phone: body.phone ?? null,
        lifecycleStatus: "ONBOARDING",
      });

      return { success: true, userId: linkedUser.id };
    }

    const userId = randomUUID();

    const newUser = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({
          id: userId,
          email: body.email.toLowerCase(),
          name: `${body.firstName} ${body.lastName}`,
          firstName: body.firstName,
          lastName: body.lastName,
          phone: body.phone,
          whatsappNumber: body.whatsappSameAsPhone ? body.phone : body.whatsappNumber,
          gender: body.gender,
          designation: body.designation,
          orgDepartmentId: body.departmentId,
          role,
          employeeId: resolvedEmployeeId,
          joiningDate: body.joiningDate ? formatDateOnly(new Date(body.joiningDate)) : undefined,
          dateOfBirth: body.dateOfBirth ? formatDateOnly(new Date(body.dateOfBirth)) : undefined,
          taxId: body.taxId ? encrypt(body.taxId) : undefined,
          monthlySalary: body.monthlySalary?.toString(),
          bankDetails: body.bankDetails?.accountNumber
            ? encryptBankDetails(toBankDetails(body.bankDetails))
            : undefined,
          isActive: true,
          hasDashboardAccess: true,
        })
        .returning();

      if (!created) throw new InternalServerErrorException("Failed to create user record.");

      const createdMembership = await tx
        .insert(organizationMembers)
        .values({ orgId: actor.orgId, userId: created.id, role })
        .returning({ id: organizationMembers.id });
      if (createdMembership[0]) 
        await syncStructuralRoleAssignment(tx, actor.orgId, createdMembership[0].id, role);
      

      if (body.monthlySalary && body.monthlySalary > 0) {
        const effectiveFrom = body.joiningDate
          ? formatDateOnly(new Date(body.joiningDate))
          : formatDateOnly(new Date());
        await seedEmployeeSalaryProfile(tx, {
          orgId: actor.orgId,
          userId: created.id,
          actorId: actor.userId,
          monthlySalary: body.monthlySalary,
          effectiveFrom,
        });
      }

      return created;
    });

    await this.invalidateHrDashboardCache(actor.orgId);

    void this.automation
      .runAutomationsForEvent(actor.orgId, "onboarding.started", {
        userId: newUser.id,
        employeeName: `${body.firstName} ${body.lastName}`,
        employeeEmail: body.email,
        departmentId: body.departmentId ?? null,
        joiningDate: body.joiningDate ?? null,
        startedAt: new Date().toISOString(),
      })
      .catch(() => undefined);

    this.webhooks.dispatch(actor.orgId, "employee.hired", {
      userId: newUser.id,
      email: newUser.email,
      firstName: newUser.firstName,
      lastName: newUser.lastName,
      joiningDate: body.joiningDate ?? null,
    });

    this.audit.log({
      action: "hr.employee_onboarded",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: newUser.id,
      targetType: "employee",
      metadata: {
        email: body.email,
        name: `${body.firstName} ${body.lastName}`,
        role: body.role,
        designation: body.designation,
      },
    });

    await this.personEmploymentSync.ensureFromUser(actor.orgId, actor.userId, {
      userId: newUser.id,
      firstName: body.firstName,
      lastName: body.lastName,
      workEmail: body.email,
      employeeNumber: resolvedEmployeeId,
      joiningDate: body.joiningDate
        ? formatDateOnly(new Date(body.joiningDate))
        : null,
      designation: body.designation ?? null,
      phone: body.phone ?? null,
      lifecycleStatus: "ONBOARDING",
    });

    if (newUser.email) {
      try {
        const rawToken = randomBytes(32).toString("hex");
        const tokenHash = hashToken(rawToken);
        await this.db.insert(magicLinkTokens).values({
          id: randomUUID(),
          userId: newUser.id,
          tokenHash,
          expiresAt: addDays(new Date(), 7),
        });
        const signInUrl = `${appUrl}/magic-link?token=${rawToken}`;
        await this.email.sendWelcomeEmail(newUser.email, `${body.firstName} ${body.lastName}`, signInUrl);
      } catch (emailErr) {
        logger.error("Failed to send welcome email", { email: newUser.email, error: emailErr });
      }
    }

    return { success: true, userId: newUser.id };
  }

  private async invalidateHrDashboardCache(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidate(`hr:analytics:${orgId}`),
      this.cache.invalidate(`hr:dashboard:metrics:${orgId}`),
      this.cache.invalidate(`hr:dashboard:headcount-trends:${orgId}`),
      this.cache.invalidate(`hr:celebrations:${orgId}`),
      this.cache.invalidate(`hr:salary-bands:${orgId}`),
      this.cache.invalidate(`hr:dashboard:payroll-summary:${orgId}`),
    ]);
  }
}
