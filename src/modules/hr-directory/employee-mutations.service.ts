import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  employeeSkills,
  onboardingTasks,
  organizationMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { HrAutomationEngineService } from "../hr-automations/hr-automation-engine.service";
import { encrypt, encryptBankDetails, type BankDetails } from "../onboarding/crypto.helpers";
import { differenceInDays } from "../../common/date";
import { userCan } from "./ability.helpers";
import type { UpdateEmployeeInput } from "./dto/hr-directory.schemas";
import { hrEmployments, hrPeople } from "../../db/schema/hr/core-people";

type BankDetailsInput = NonNullable<UpdateEmployeeInput["bankDetails"]> & {
  pfUanNumber?: string;
  esiIpNumber?: string;
};

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
    private readonly hrAutomation: HrAutomationEngineService,
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
    if (!isSelf && !isOwnerOrAdmin) {
      throw new ForbiddenException("You can only update your own profile.");
    }

    if (body.isActive === false) {
      throw new BadRequestException(
        "Employees can only be terminated through the dedicated termination workflow, which requires final approval and creates the required settlement and asset-return records.",
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
}
