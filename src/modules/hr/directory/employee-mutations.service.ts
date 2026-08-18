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
import { assertUsersInOrg } from "../../../common/tenant/org-membership";
import { syncOrgUnitPlacement } from "../../../common/org/sync-org-unit-placement";
import { syncCanonicalEmploymentFields } from "../../../common/hr/sync-canonical-employment-fields";
import { applyScope } from "../../access/apply-scope";
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import { resolveEmployeesManageScope } from "./employees-scope";

@Injectable()
export class EmployeeMutationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly hrAutomation: HrAutomationEngineService,
    private readonly access: AccessService,
  ) {}

  async getEmployeeDetail(
    orgId: string,
    actorUserId: string,
    targetUserId: string,
    scope: DataScope,
  ) {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, targetUserId),
        applyScope(scope, orgId, actorUserId, {
          ownerColumn: organizationMembers.userId,
        }),
      ),
      columns: { userId: true, role: true },
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            firstName: true,
            lastName: true,
            email: true,
            designation: true,
            employeeId: true,
            orgDepartmentId: true,
            image: true,
            isActive: true,
            joiningDate: true,
            reportingTo: true,
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
      .where(
        and(
          eq(employeeSkills.orgId, orgId),
          eq(employeeSkills.userId, targetUserId),
        ),
      );

    const [employment] = await this.db
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
          eq(hrPeople.userId, targetUserId),
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
      role: member.role,
      designation: employment?.designation ?? u.designation,
      employeeId: employment?.employeeNumber ?? u.employeeId,
      orgDepartmentId: employment?.departmentId ?? u.orgDepartmentId,
      image: u.image,
      isActive: u.isActive,
      joiningDate: employment?.joiningDate ?? u.joiningDate,
      reportingTo: u.reportingTo,
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
    const isSelf = actor.userId === targetUserId;
    const manageScope = await resolveEmployeesManageScope(this.access, actor);
    if (!isSelf && manageScope === "none") {
      throw new ForbiddenException("You do not have permission to update this employee.");
    }

    const effectiveScope: DataScope = isSelf && manageScope === "none" ? "own" : manageScope;
    const targetMember = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, targetUserId),
        eq(organizationMembers.orgId, actor.orgId),
        applyScope(effectiveScope, actor.orgId, actor.userId, {
          ownerColumn: organizationMembers.userId,
        }),
      ),
    });
    if (!targetMember) {
      throw new ForbiddenException("You do not have permission to update this employee.");
    }

    const currentUser = await this.db.query.users.findFirst({
      where: eq(users.id, targetUserId),
      columns: { firstName: true, lastName: true, name: true, joiningDate: true },
    });
    if (!currentUser) {
      throw new BadRequestException("Employee record is unavailable.");
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
      await assertUsersInOrg(this.db, actor.orgId, [body.reportingTo]);
      const [cycle] = await this.db.execute<{ creates_cycle: boolean }>(sql`
        WITH RECURSIVE manager_chain AS (
          SELECT u.id, u.reporting_to, ARRAY[u.id]::text[] AS path
          FROM users u
          INNER JOIN organization_members om
            ON om.user_id = u.id AND om.org_id = ${actor.orgId}
          WHERE u.id = ${body.reportingTo}
          UNION ALL
          SELECT manager.id, manager.reporting_to, chain.path || manager.id
          FROM users manager
          INNER JOIN organization_members om
            ON om.user_id = manager.id AND om.org_id = ${actor.orgId}
          INNER JOIN manager_chain chain ON manager.id = chain.reporting_to
          WHERE NOT manager.id = ANY(chain.path)
            AND cardinality(chain.path) < 1000
        )
        SELECT EXISTS (
          SELECT 1 FROM manager_chain WHERE id = ${targetUserId}
        ) AS creates_cycle
      `);
      if (cycle?.creates_cycle) {
        throw new BadRequestException(
          "This reporting structure would create a circular management chain.",
        );
      }
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
    if (body.designation !== undefined) updateData.designation = body.designation;
    if (body.departmentId !== undefined) updateData.orgDepartmentId = body.departmentId;
    if (body.phone !== undefined) updateData.phone = body.phone;
    if (body.image !== undefined) updateData.image = body.image;
    if (body.isActive !== undefined) updateData.isActive = body.isActive;
    if (body.bio !== undefined) updateData.bio = body.bio;
    if (body.linkedinUrl !== undefined) updateData.linkedinUrl = body.linkedinUrl || null;
    if (body.twitterUrl !== undefined) updateData.twitterUrl = body.twitterUrl || null;
    if (body.githubUrl !== undefined) updateData.githubUrl = body.githubUrl || null;
    if (body.websiteUrl !== undefined) updateData.websiteUrl = body.websiteUrl || null;
    if (body.joiningDate !== undefined) updateData.joiningDate = body.joiningDate;
    if (body.reportingTo !== undefined) updateData.reportingTo = body.reportingTo;

    let canonicalJoiningDateSynced: boolean | null = null;
    const oldJoiningDate = currentUser.joiningDate;
    await this.db.transaction(async (tx) => {
      if (Object.keys(updateData).length > 0) {
        await tx.update(users).set(updateData).where(eq(users.id, targetUserId));
      }
      await syncOrgUnitPlacement(tx, actor.orgId, targetUserId, { DEPARTMENT: body.departmentId });
      if (body.joiningDate !== undefined) {
        canonicalJoiningDateSynced = await syncCanonicalEmploymentFields(
          tx,
          actor.orgId,
          targetUserId,
          { joiningDate: body.joiningDate },
        );
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

      if (body.joiningDate && manageScope !== "none") {
        const oldDate = oldJoiningDate ? new Date(oldJoiningDate) : null;
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

    await this.audit.logCritical({
      action: "hr.employee_updated",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: targetUserId,
      targetType: "employee",
      metadata: {
        changedFields: Object.keys(updateData),
        ...(canonicalJoiningDateSynced !== null && { canonicalJoiningDateSynced }),
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
