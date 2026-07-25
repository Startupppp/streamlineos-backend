import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { addDays } from "date-fns";
import {
  employeeSkills,
  magicLinkTokens,
  onboardingTasks,
  organizationMembers,
  orgDepartments,
  users,
} from "../../db/schema";
import { hashToken } from "../../common/security/token.util";
import { nextDepartmentCode, toDepartmentCode } from "../org-hierarchy/lib/department-code";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { logger } from "../../common/logger/logger.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { EmailService } from "../email/email.service";
import { appUrl } from "../email/app-url";
import { AutomationService } from "../automation/automation.service";
import { HrAutomationEngineService } from "../hr-automations/hr-automation-engine.service";
import { WebhooksDispatchService } from "../webhooks/webhooks-dispatch.service";
import { PersonEmploymentSyncService } from "../hr-core/person-employment-sync.service";
import { encrypt, encryptBankDetails, type BankDetails } from "../onboarding/crypto.helpers";
import { differenceInDays, formatDateOnly } from "./date.helpers";
import { userCan } from "./ability.helpers";
import { seedEmployeeSalaryProfile } from "./salary-profile-seed.helper";
import type {
  BulkOnboardEmployeeRow,
  OnboardEmployeeInput,
  UpdateEmployeeInput,
} from "./dto/hr-directory.schemas";
import { hrEmployments, hrPeople } from "../../db/schema/hr/core-people";

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
export class EmployeeMutationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly automation: AutomationService,
    private readonly hrAutomation: HrAutomationEngineService,
    private readonly webhooks: WebhooksDispatchService,
    private readonly personEmploymentSync: PersonEmploymentSyncService,
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
            orgDepartmentId: true,
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

    const [employment] = await this.db
      .select({
        id: hrEmployments.id,
        personId: hrEmployments.personId,
        employeeNumber: hrEmployments.employeeNumber,
        lifecycleStatus: hrEmployments.lifecycleStatus,
        workerType: hrEmployments.workerType,
        designation: hrEmployments.designation,
        joiningDate: hrEmployments.joiningDate,
        probationEndDate: hrEmployments.probationEndDate,
        confirmationDate: hrEmployments.confirmationDate,
      })
      .from(hrPeople)
      .innerJoin(
        hrEmployments,
        and(
          eq(hrEmployments.personId, hrPeople.id),
          eq(hrEmployments.orgId, orgId),
          eq(hrEmployments.isPrimary, true),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .where(
        and(
          eq(hrPeople.orgId, orgId),
          eq(hrPeople.userId, userId),
          isNull(hrPeople.deletedAt),
        ),
      )
      .limit(1);

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
      orgDepartmentId: u.orgDepartmentId,
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
      employmentStatus: employment?.lifecycleStatus ?? null,
      employment: employment
        ? {
            id: employment.id,
            personId: employment.personId,
            employeeNumber: employment.employeeNumber,
            lifecycleStatus: employment.lifecycleStatus,
            workerType: employment.workerType,
            designation: employment.designation,
            joiningDate: employment.joiningDate,
            probationEndDate: employment.probationEndDate,
            confirmationDate: employment.confirmationDate,
          }
        : null,
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
      throw new BadRequestException(
        "Employees can only be terminated through the dedicated termination workflow, which requires CEO approval and creates the required settlement and asset-return records.",
      );
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
    if (body.departmentId !== undefined) updateData.orgDepartmentId = body.departmentId;
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

    this.audit.log({
      action: "hr.employee_updated",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: targetUserId,
      targetType: "employee",
      metadata: { changedFields: Object.keys(updateData) },
    });

    if (
      updateData.name !== undefined ||
      updateData.firstName !== undefined ||
      updateData.lastName !== undefined ||
      updateData.image !== undefined
    ) {
      await this.cache.invalidate(CACHE_KEYS.userSession(targetUserId));
    }

    void this.hrAutomation
      .emit(actor.orgId, "employee.updated", {
        employeeId: targetUserId,
        changedFields: Object.keys(updateData),
        updatedBy: actor.userId,
      })
      .catch(() => undefined);

    return { success: true };
  }

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

    const role = body.role || "ENGINEERING";

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
        await tx.insert(organizationMembers).values({ orgId: actor.orgId, userId: existingUser.id, role });

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

      await tx.insert(organizationMembers).values({ orgId: actor.orgId, userId: created.id, role });

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

  /**
   * Bulk onboard from spreadsheet rows. Continues past individual failures so
   * partial success is reported with per-row errors (row numbers are 1-based data rows).
   */
  async onboardEmployeesBulk(actor: CurrentUserContext, rows: BulkOnboardEmployeeRow[]) {
    const orgDeptRows = await this.db
      .select({
        id: orgDepartments.id,
        name: orgDepartments.name,
        code: orgDepartments.code,
      })
      .from(orgDepartments)
      .where(
        and(
          eq(orgDepartments.orgId, actor.orgId),
          isNull(orgDepartments.deletedAt),
          sql`${orgDepartments.status} <> 'ARCHIVED'`,
        ),
      );

    const orgDeptByKey = new Map<string, string>();
    const usedCodes = new Set<string>();
    for (const d of orgDeptRows) {
      orgDeptByKey.set(d.name.trim().toLowerCase(), d.id);
      if (d.code?.trim()) orgDeptByKey.set(d.code.trim().toLowerCase(), d.id);
      usedCodes.add(d.code);
    }

    const resolveDepartmentId = async (raw: string): Promise<string | undefined> => {
      const key = raw.trim().toLowerCase();
      if (!key) return undefined;

      const existing = orgDeptByKey.get(key);
      if (existing) return existing;

      const name = raw.trim();
      const base = toDepartmentCode(name);
      let code = base;
      let suffix = 2;
      while (usedCodes.has(code)) {
        code = nextDepartmentCode(base, suffix);
        suffix += 1;
      }

      const inserted = await this.db
        .insert(orgDepartments)
        .values({ orgId: actor.orgId, name, code, status: "ACTIVE" })
        .onConflictDoNothing({ target: [orgDepartments.orgId, orgDepartments.code] })
        .returning({ id: orgDepartments.id, name: orgDepartments.name });

      let row = inserted[0];
      if (!row) {
        const [found] = await this.db
          .select({ id: orgDepartments.id, name: orgDepartments.name })
          .from(orgDepartments)
          .where(
            and(
              eq(orgDepartments.orgId, actor.orgId),
              isNull(orgDepartments.deletedAt),
              sql`lower(${orgDepartments.name}) = ${key}`,
            ),
          )
          .limit(1);
        row = found;
      }
      if (!row) return undefined;

      usedCodes.add(code);
      orgDeptByKey.set(row.name.trim().toLowerCase(), row.id);
      return row.id;
    };

    // Detect duplicate emails within the same upload
    const seenEmails = new Set<string>();
    const results: Array<{
      row: number;
      email: string;
      success: boolean;
      userId?: string;
      error?: string;
    }> = [];

    let created = 0;
    let failed = 0;

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const rowNum = i + 1;
      const email = row.email.trim().toLowerCase();

      if (seenEmails.has(email)) {
        failed += 1;
        results.push({
          row: rowNum,
          email,
          success: false,
          error: "Duplicate email in this upload",
        });
        continue;
      }
      seenEmails.add(email);

      let departmentId = row.departmentId;
      if (departmentId == null && row.department) {
        departmentId = await resolveDepartmentId(row.department);
        if (departmentId == null) {
          failed += 1;
          results.push({
            row: rowNum,
            email,
            success: false,
            error: `Unknown department "${row.department}". Create it under Organization → Departments (or HR departments) first.`,
          });
          continue;
        }
      }

      const payload: OnboardEmployeeInput = {
        firstName: row.firstName.trim(),
        lastName: row.lastName.trim(),
        email,
        phone: row.phone,
        whatsappSameAsPhone: row.whatsappSameAsPhone ?? true,
        whatsappNumber: row.whatsappNumber,
        gender: row.gender,
        designation: row.designation.trim(),
        departmentId,
        role: row.role || "ENGINEERING",
        employeeId: row.employeeId,
        joiningDate: row.joiningDate,
        dateOfBirth: row.dateOfBirth,
        taxId: row.taxId,
        monthlySalary: row.monthlySalary,
        bankDetails: row.bankDetails,
      };

      try {
        const res = await this.onboardEmployee(actor, payload);
        created += 1;
        results.push({
          row: rowNum,
          email,
          success: true,
          userId: res.userId,
        });
      } catch (err) {
        failed += 1;
        const message =
          err instanceof Error ? err.message : "Failed to onboard employee";
        results.push({ row: rowNum, email, success: false, error: message });
      }
    }

    this.audit.log({
      action: "hr.employees_bulk_onboarded",
      userId: actor.userId,
      orgId: actor.orgId,
      targetType: "employee",
      metadata: { total: rows.length, created, failed },
    });

    return {
      total: rows.length,
      created,
      failed,
      results,
    };
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
