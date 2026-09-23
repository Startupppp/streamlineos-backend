import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  employeeSkills,
  onboardingTasks,
  organizationMembers,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { HrAutomationEngineService } from "../automations/hr-automation-engine.service";
import { differenceInDays } from "../../../common/date";
import type { UpdateEmployeeInput } from "./dto/hr-directory.schemas";
import { hrEmployments, hrPeople } from "../../../db/schema/hr/core-people";
import { syncOrgUnitPlacement } from "../../../common/org/sync-org-unit-placement";
import { syncCanonicalEmploymentFields } from "../../../common/hr/sync-canonical-employment-fields";
import { AccessService } from "../../access/access.service";
import { ScopedRead } from "../../access/scoped-read";
import { selfEmployeeRead } from "./employees-scope";
import { resolveEmployeesManageScope } from "./employees-scope";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { ReportingLineService } from "../../directory/reporting-line.service";
import { emptyEmploymentFacts } from "../../directory/employment-facts.types";
import {
  livePersonOfUser,
  primaryEmploymentOfPerson,
} from "../../directory/employment-query";

@Injectable()
export class EmployeeMutationsService {
  private readonly logger = new Logger(EmployeeMutationsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly hrAutomation: HrAutomationEngineService,
    private readonly access: AccessService,
    private readonly employment: EmploymentFactsService,
    private readonly reportingLines: ReportingLineService,
  ) {}

  private async degraded<T>(
    targetUserId: string,
    part: string,
    fallback: T,
    read: () => Promise<T>,
  ): Promise<T> {
    try {
      return await read();
    } catch (error: unknown) {
      this.logger.error(
        `employee detail: ${part} unavailable for ${targetUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return fallback;
    }
  }

  async getEmployeeDetail(read: ScopedRead, targetUserId: string) {
    const orgId = read.orgId;
    const member = await read.read(
      {
        tenant: organizationMembers.orgId,
        scope: { columns: { ownerColumn: organizationMembers.userId } },
        and: [eq(organizationMembers.userId, targetUserId)],
      },
      ({ sql: where }) =>
        this.db.query.organizationMembers.findFirst({
          where,
          columns: { userId: true, role: true },
          with: {
            user: {
              columns: {
                id: true,
                name: true,
                firstName: true,
                lastName: true,
                email: true,
                image: true,
                isActive: true,
                bio: true,
                linkedinUrl: true,
                twitterUrl: true,
                githubUrl: true,
                websiteUrl: true,
                phone: true,
              },
            },
          },
        }),
      () => undefined,
    );

    if (!member?.user) return null;
    const u = member.user;

    const [skillRows, employment, facts] = await Promise.all([
      this.degraded(targetUserId, "skills", [] as { name: string; level: number }[], () =>
        this.db
        .select({ name: employeeSkills.skillName, level: employeeSkills.level })
        .from(employeeSkills)
        .where(
          and(
            eq(employeeSkills.orgId, orgId),
            eq(employeeSkills.userId, targetUserId),
          ),
        )
        .limit(100),
      ),
      this.degraded(targetUserId, "employment", null, () =>
        this.db
        .select({
          id: hrEmployments.id,
          personId: hrEmployments.personId,
          employeeNumber: hrEmployments.employeeNumber,
          lifecycleStatus: hrEmployments.lifecycleStatus,
          workerType: hrEmployments.workerType,
          departmentId: hrEmployments.departmentId,
          designation: hrEmployments.designation,
          joiningDate: hrEmployments.joiningDate,
          probationEndDate: hrEmployments.probationEndDate,
          confirmationDate: hrEmployments.confirmationDate,
        })
        .from(hrPeople)
        .innerJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .where(livePersonOfUser(orgId, targetUserId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      ),
      this.degraded(targetUserId, "employment-facts", emptyEmploymentFacts(targetUserId), () =>
        this.employment.getFacts(orgId, targetUserId),
      ),
    ]);

    return {
      id: u.id,
      name: u.name,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      role: member.role,
      designation: employment?.designation ?? null,
      employeeId: employment?.employeeNumber ?? null,
      orgDepartmentId: employment?.departmentId ?? null,
      image: u.image,
      isActive: u.isActive,
      joiningDate: employment?.joiningDate ?? null,
      reportingTo: facts.managerUserId,
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
            departmentId: employment.departmentId,
            designation: employment.designation,
            joiningDate: employment.joiningDate,
            probationEndDate: employment.probationEndDate,
            confirmationDate: employment.confirmationDate,
          }
        : null,
    };
  }

  async updateEmployee(
    actor: CurrentUserContext,
    targetUserId: string,
    body: UpdateEmployeeInput,
  ) {
    const isSelf = actor.userId === targetUserId;
    const manageRead = await resolveEmployeesManageScope(this.access, actor);
    if (!isSelf && manageRead.denied) {
      throw new ForbiddenException(
        "You do not have permission to update this employee.",
      );
    }

    const effectiveRead =
      isSelf && manageRead.denied ? selfEmployeeRead(actor) : manageRead;
    const targetMember = await effectiveRead.read(
      {
        tenant: organizationMembers.orgId,
        scope: { columns: { ownerColumn: organizationMembers.userId } },
        and: [eq(organizationMembers.userId, targetUserId)],
      },
      ({ sql: where }) =>
        this.db.query.organizationMembers.findFirst({
          columns: { id: true },
          where,
        }),
      () => undefined,
    );
    if (!targetMember) {
      throw new ForbiddenException(
        "You do not have permission to update this employee.",
      );
    }

    const currentUser = await this.db.query.users.findFirst({
      where: eq(users.id, targetUserId),
      columns: { firstName: true, lastName: true, name: true },
    });
    if (!currentUser) {
      throw new BadRequestException("Employee record is unavailable.");
    }

    if (body.isActive === false) {
      throw new BadRequestException(
        "Employees can only be terminated through the dedicated termination workflow, which requires final approval and creates the required settlement and asset-return records.",
      );
    }

    const updateData: Partial<typeof users.$inferInsert> = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.firstName !== undefined || body.lastName !== undefined) {
      const first = body.firstName ?? currentUser.firstName ?? "";
      const last = body.lastName ?? currentUser.lastName ?? "";
      updateData.firstName = first;
      updateData.lastName = last;
      if (!body.name) updateData.name = `${first} ${last}`.trim();
    }
    if (body.gender !== undefined) updateData.gender = body.gender;
    if (body.phone !== undefined) updateData.phone = body.phone;
    if (body.image !== undefined) updateData.image = body.image;
    if (body.isActive !== undefined) updateData.isActive = body.isActive;
    if (body.bio !== undefined) updateData.bio = body.bio;
    if (body.linkedinUrl !== undefined)
      updateData.linkedinUrl = body.linkedinUrl || null;
    if (body.twitterUrl !== undefined)
      updateData.twitterUrl = body.twitterUrl || null;
    if (body.githubUrl !== undefined)
      updateData.githubUrl = body.githubUrl || null;
    if (body.websiteUrl !== undefined)
      updateData.websiteUrl = body.websiteUrl || null;

    let canonicalSynced: boolean | null = null;
    let oldJoiningDate: string | null = null;
    if (body.joiningDate !== undefined) {
      const facts = await this.employment.getFacts(actor.orgId, targetUserId);
      oldJoiningDate = facts.joiningDate;
    }

    await this.db.transaction(async (tx) => {
      if (Object.keys(updateData).length > 0) {
        await tx
          .update(users)
          .set(updateData)
          .where(eq(users.id, targetUserId));
      }
      await syncOrgUnitPlacement(tx, actor.orgId, targetUserId, {
        DEPARTMENT: body.departmentId,
      });
      if (
        body.designation !== undefined ||
        body.departmentId !== undefined ||
        body.joiningDate !== undefined
      ) {
        canonicalSynced = await syncCanonicalEmploymentFields(
          tx,
          actor.orgId,
          targetUserId,
          {
            designation: body.designation,
            departmentId: body.departmentId,
            joiningDate: body.joiningDate,
          },
        );
      }
      if (body.reportingTo !== undefined) {
        const today = new Date().toISOString().slice(0, 10);
        await this.reportingLines.assign(
          actor.orgId,
          targetUserId,
          body.reportingTo ?? null,
          today,
          actor.userId,
          tx,
        );
      }

      if (body.skills !== undefined) {
        const existing = await tx
          .select({ skillName: employeeSkills.skillName })
          .from(employeeSkills)
          .where(
            and(
              eq(employeeSkills.orgId, actor.orgId),
              eq(employeeSkills.userId, targetUserId),
            ),
          )
          .limit(100);

        const existingNames = new Set(existing.map((s) => s.skillName));
        const newNames = new Set(body.skills);

        const toDelete = existing
          .filter((s) => !newNames.has(s.skillName))
          .map((s) => s.skillName);
        if (toDelete.length > 0) {
          await tx
            .delete(employeeSkills)
            .where(
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
            toInsert.map((skillName) => ({
              orgId: actor.orgId,
              userId: targetUserId,
              skillName,
              level: 1,
            })),
          );
        }
      }

      if (body.joiningDate && !manageRead.denied) {
        const oldDate = oldJoiningDate ? new Date(oldJoiningDate) : null;
        const newDate = new Date(body.joiningDate);
        if (oldDate && oldDate.getTime() !== newDate.getTime()) {
          const dayDiff = differenceInDays(newDate, oldDate);
          await tx
            .update(onboardingTasks)
            .set({
              dueDate: sql<Date>`${onboardingTasks.dueDate} + (${dayDiff} * interval '1 day')`,
            })
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

    await this.audit.logCritical({
      action: "hr.employee_updated",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: targetUserId,
      targetType: "employee",
      metadata: {
        changedFields: Object.keys(updateData),
        ...(canonicalSynced !== null && { canonicalSynced }),
      },
    });

    if (
      updateData.name !== undefined ||
      updateData.firstName !== undefined ||
      updateData.lastName !== undefined ||
      updateData.image !== undefined
    ) {
      await this.cache.invalidate(CACHE_KEYS.userSession(targetUserId));
    }

    await this.cache.invalidateNamespace(
      CACHE_KEYS.hrEmployeesListNamespace(actor.orgId),
    );

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
