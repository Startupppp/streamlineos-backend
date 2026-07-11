import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import {
  employeeSkills,
  onboardingTasks,
  organizationMembers,
  passwordResetTokens,
  payrollPolicies,
  payrollPolicyVersions,
  salaryStructures,
  users,
} from "../../db/schema";
import { resolvePayrollDefaults } from "../hr-payroll/lib/payroll-defaults";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { logger } from "../../common/logger/logger.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { EmailService } from "../email/email.service";
import { appUrl } from "../email/app-url";
import { AutomationService } from "../automation/automation.service";
import { HrAutomationEngineService } from "../hr-automations/hr-automation-engine.service";
import { WebhooksDispatchService } from "../webhooks/webhooks-dispatch.service";
import { encrypt, encryptBankDetails, type BankDetails } from "../onboarding/crypto.helpers";
import { differenceInDays, formatDateOnly, formatDayMonthYear } from "./date.helpers";
import { userCan } from "./ability.helpers";
import type { OnboardEmployeeInput, UpdateEmployeeInput } from "./dto/hr-directory.schemas";

type BankDetailsInput = NonNullable<UpdateEmployeeInput["bankDetails"]> & { pfUanNumber?: string };

const EMP_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomEmployeeCode(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += EMP_CODE_ALPHABET[bytes[i] % EMP_CODE_ALPHABET.length];
  return out;
}

function randomToken(length: number): string {
  return randomBytes(length).toString("base64url").slice(0, length);
}

function toBankDetails(input: BankDetailsInput): BankDetails {
  return {
    accountNumber: input.accountNumber ?? "",
    bankName: input.bankName ?? "",
    branch: input.branch ?? "",
    ifsc: input.ifsc ?? "",
    accountHolder: input.accountHolder ?? "",
    ...(input.pfUanNumber !== undefined ? { pfUanNumber: input.pfUanNumber } : {}),
  };
}

@Injectable()
export class EmployeeMutationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly automation: AutomationService,
    private readonly hrAutomation: HrAutomationEngineService,
    private readonly webhooks: WebhooksDispatchService,
  ) {}

  async getEmployeeDetail(orgId: string, userId: string) {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)),
      columns: { userId: true },
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            firstName: true,
            lastName: true,
            email: true,
            role: true,
            designation: true,
            employeeId: true,
            departmentId: true,
            image: true,
            isActive: true,
            joiningDate: true,
            hasDashboardAccess: true,
            reportingTo: true,
            monthlySalary: true,
            bio: true,
            linkedinUrl: true,
            twitterUrl: true,
            githubUrl: true,
            websiteUrl: true,
            phone: true,
          },
        },
      },
    });

    if (!member?.user) return null;
    const u = member.user;

    const skillRows = await this.db
      .select({ name: employeeSkills.skillName, level: employeeSkills.level })
      .from(employeeSkills)
      .where(and(eq(employeeSkills.orgId, orgId), eq(employeeSkills.userId, userId)));

    return {
      id: u.id,
      name: u.name,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      role: u.role,
      designation: u.designation,
      employeeId: u.employeeId,
      departmentId: u.departmentId,
      image: u.image,
      isActive: u.isActive,
      joiningDate: u.joiningDate,
      hasDashboardAccess: u.hasDashboardAccess,
      reportingTo: u.reportingTo,
      monthlySalary: u.monthlySalary,
      bio: u.bio ?? null,
      linkedinUrl: u.linkedinUrl ?? null,
      twitterUrl: u.twitterUrl ?? null,
      githubUrl: u.githubUrl ?? null,
      websiteUrl: u.websiteUrl ?? null,
      skills: skillRows,
      phone: u.phone ?? null,
    };
  }

  async updateEmployee(actor: CurrentUserContext, targetUserId: string, body: UpdateEmployeeInput) {
    const targetMember = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.userId, targetUserId), eq(organizationMembers.orgId, actor.orgId)),
    });
    if (!targetMember) throw new ForbiddenException("User not found in your organization.");

    const isSelf = actor.userId === targetUserId;
    const isOwnerOrAdmin = userCan(actor, "manage", "hr:employees");
    const canManageEmployees = isOwnerOrAdmin || actor.role === "HR" || actor.role === "CEO";
    if (!isSelf && !canManageEmployees) {
      throw new ForbiddenException("You can only update your own profile.");
    }

    if (body.isActive === false) {
      if (!canManageEmployees) throw new ForbiddenException("Only HR or CEO can terminate employees.");
      if (isSelf) throw new BadRequestException("You cannot terminate your own account.");
      if (targetMember.role === "CEO" || targetMember.isOwner) {
        throw new BadRequestException("CEO cannot be terminated through this workflow.");
      }
    }

    if (body.reportingTo !== undefined && body.reportingTo !== null) {
      if (body.reportingTo === targetUserId) {
        throw new BadRequestException("An employee cannot report to themselves.");
      }
      let cursor: string | null = body.reportingTo;
      const visited = new Set<string>([targetUserId]);
      while (cursor) {
        if (visited.has(cursor)) {
          throw new BadRequestException("This reporting structure would create a circular management chain.");
        }
        visited.add(cursor);
        const mgr: { reportingTo: string | null } | undefined = await this.db.query.users.findFirst({
          where: eq(users.id, cursor),
          columns: { reportingTo: true },
        });
        cursor = mgr?.reportingTo ?? null;
      }
    }

    const targetUser =
      body.isActive === false
        ? await this.db.query.users.findFirst({ where: eq(users.id, targetUserId) })
        : null;

    const updateData: Partial<typeof users.$inferInsert> = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.firstName !== undefined || body.lastName !== undefined) {
      const existing = await this.db.query.users.findFirst({
        where: eq(users.id, targetUserId),
        columns: { firstName: true, lastName: true, name: true },
      });
      const first = body.firstName ?? existing?.firstName ?? "";
      const last = body.lastName ?? existing?.lastName ?? "";
      updateData.firstName = first;
      updateData.lastName = last;
      if (!body.name) updateData.name = `${first} ${last}`.trim();
    }
    if (body.role !== undefined && isOwnerOrAdmin) updateData.role = body.role;
    if (body.gender !== undefined) updateData.gender = body.gender;
    if (body.taxId !== undefined) updateData.taxId = body.taxId ? encrypt(body.taxId) : "";
    if (body.monthlySalary !== undefined && isOwnerOrAdmin) updateData.monthlySalary = String(body.monthlySalary);
    if (body.bankDetails !== undefined) {
      updateData.bankDetails = body.bankDetails ? encryptBankDetails(toBankDetails(body.bankDetails)) : null;
    }
    if (body.designation !== undefined) updateData.designation = body.designation;
    if (body.departmentId !== undefined) updateData.departmentId = body.departmentId;
    if (body.phone !== undefined) updateData.phone = body.phone;
    if (body.image !== undefined) updateData.image = body.image;
    if (body.isActive !== undefined) updateData.isActive = body.isActive;
    if (body.hasDashboardAccess !== undefined) {
      if (!isOwnerOrAdmin) throw new ForbiddenException("Only admins can toggle dashboard access.");
      updateData.hasDashboardAccess = body.hasDashboardAccess;
    }
    if (body.bio !== undefined) updateData.bio = body.bio;
    if (body.linkedinUrl !== undefined) updateData.linkedinUrl = body.linkedinUrl || null;
    if (body.twitterUrl !== undefined) updateData.twitterUrl = body.twitterUrl || null;
    if (body.githubUrl !== undefined) updateData.githubUrl = body.githubUrl || null;
    if (body.websiteUrl !== undefined) updateData.websiteUrl = body.websiteUrl || null;
    if (body.joiningDate !== undefined) updateData.joiningDate = body.joiningDate;
    if (body.reportingTo !== undefined) updateData.reportingTo = body.reportingTo;

    await this.db.transaction(async (tx) => {
      if (Object.keys(updateData).length > 0) {
        await tx.update(users).set(updateData).where(eq(users.id, targetUserId));
      }

      if (body.skills !== undefined) {
        const existing = await tx
          .select({ skillName: employeeSkills.skillName })
          .from(employeeSkills)
          .where(and(eq(employeeSkills.orgId, actor.orgId), eq(employeeSkills.userId, targetUserId)));

        const existingNames = new Set(existing.map((s) => s.skillName));
        const newNames = new Set(body.skills);

        const toDelete = existing.filter((s) => !newNames.has(s.skillName)).map((s) => s.skillName);
        if (toDelete.length > 0) {
          await tx.delete(employeeSkills).where(
            and(
              eq(employeeSkills.orgId, actor.orgId),
              eq(employeeSkills.userId, targetUserId),
              inArray(employeeSkills.skillName, toDelete),
            ),
          );
        }

        const toInsert = body.skills.filter((name) => !existingNames.has(name));
        if (toInsert.length > 0) {
          await tx.insert(employeeSkills).values(
            toInsert.map((skillName) => ({ orgId: actor.orgId, userId: targetUserId, skillName, level: 1 })),
          );
        }
      }

      if (body.joiningDate && isOwnerOrAdmin) {
        const currentUser = await tx.query.users.findFirst({
          where: eq(users.id, targetUserId),
          columns: { joiningDate: true },
        });
        const oldDate = currentUser?.joiningDate ? new Date(currentUser.joiningDate) : null;
        const newDate = new Date(body.joiningDate);
        if (oldDate && oldDate.getTime() !== newDate.getTime()) {
          const dayDiff = differenceInDays(newDate, oldDate);
          await tx
            .update(onboardingTasks)
            .set({ dueDate: sql<Date>`${onboardingTasks.dueDate} + (${dayDiff} * interval '1 day')` })
            .where(
              and(
                eq(onboardingTasks.userId, targetUserId),
                eq(onboardingTasks.status, "PENDING"),
                isNotNull(onboardingTasks.dueDate),
              ),
            );
        }
      }
    });

    if (body.isActive === false) {
      await this.cache.invalidate(`user:session:${targetUserId}`);
      if (targetUser?.email) {
        const actorUser = await this.db.query.users.findFirst({
          where: eq(users.id, actor.userId),
          columns: { name: true },
        });
        void this.email
          .sendTerminationEmail(
            targetUser.email,
            targetUser.name ?? "Employee",
            targetUser.designation ?? "N/A",
            formatDayMonthYear(new Date()),
            actorUser?.name ?? "HR",
            "Termination as per company policy.",
          )
          .catch(() => undefined);
        void this.email
          .sendAccountDeactivationEmail(targetUser.email, targetUser.name ?? "Employee", actorUser?.name ?? "HR")
          .catch(() => undefined);
      }
    }

    this.audit.log({
      action: body.isActive === false ? "hr.employee_terminated" : "hr.employee_updated",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: targetUserId,
      targetType: "employee",
      metadata: { changedFields: Object.keys(updateData), isTermination: body.isActive === false },
    });

    void this.hrAutomation
      .emit(actor.orgId, "employee.updated", {
        employeeId: targetUserId,
        changedFields: Object.keys(updateData),
        updatedBy: actor.userId,
      })
      .catch(() => undefined);

    return { success: true };
  }

  private async resolveOrgPayrollDefaults(orgId: string) {
    try {
      const policy = await this.db.query.payrollPolicies.findFirst({
        where: eq(payrollPolicies.orgId, orgId),
        columns: { activeVersionId: true },
      });
      if (!policy?.activeVersionId) return resolvePayrollDefaults(null);
      const version = await this.db.query.payrollPolicyVersions.findFirst({
        where: eq(payrollPolicyVersions.id, policy.activeVersionId),
        columns: { config: true },
      });
      return resolvePayrollDefaults(version?.config ?? null);
    } catch {
      return resolvePayrollDefaults(null);
    }
  }

  async onboardEmployee(actor: CurrentUserContext, body: OnboardEmployeeInput) {
    const existing = await this.db.query.users.findFirst({
      where: eq(users.email, body.email.toLowerCase()),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("A user with this email already exists.");

    const passwordHash = randomBytes(32).toString("hex");
    const userId = randomUUID();
    const resolvedEmployeeId = body.employeeId?.trim() || `EMP-${randomEmployeeCode(6)}`;
    const role = body.role || "ENGINEERING";
    const payrollDefaults = await this.resolveOrgPayrollDefaults(actor.orgId);

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
          password: passwordHash,
          designation: body.designation,
          departmentId: body.departmentId,
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
          isPasswordChangeRequired: true,
        })
        .returning();

      if (!created) throw new InternalServerErrorException("Failed to create user record.");

      await tx.insert(organizationMembers).values({ orgId: actor.orgId, userId: created.id, role });

      if (body.monthlySalary && body.monthlySalary > 0) {
        const basicSalary = body.monthlySalary * (payrollDefaults.defaultBasicPercent / 100);
        const specialAllowance = body.monthlySalary * (payrollDefaults.defaultAllowancePercent / 100);
        await tx.insert(salaryStructures).values({
          orgId: actor.orgId,
          userId: created.id,
          basicSalary: basicSalary.toString(),
          hraPercentage: String(payrollDefaults.defaultHraPercent),
          allowances: specialAllowance.toString(),
          deductions: "0",
          effectiveFrom: body.joiningDate
            ? formatDateOnly(new Date(body.joiningDate))
            : formatDateOnly(new Date()),
          isActive: true,
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

    if (newUser.email) {
      try {
        const setupToken = randomToken(48);
        await this.db.insert(passwordResetTokens).values({
          id: randomUUID(),
          email: newUser.email,
          token: setupToken,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
        const setupUrl = `${appUrl}/setup-password?token=${setupToken}`;
        await this.email.sendWelcomeEmail(newUser.email, `${body.firstName} ${body.lastName}`, setupUrl);
      } catch (emailErr) {
        logger.error("Failed to send setup email", { email: newUser.email, error: emailErr });
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
    ]);
  }
}
