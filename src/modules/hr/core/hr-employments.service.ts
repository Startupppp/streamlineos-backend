import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  hrEmployments,
  hrEmploymentHistory,
  hrPeople,
  type hrEmploymentLifecycleStatusEnum,
} from "../../../db/schema/hr/core-people";
import { organizationMembers } from "../../../db/schema/common/auth";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type {
  CreateEmploymentInput,
  UpdateEmploymentInput,
  TransitionStatusInput,
} from "./dto/hr-core.schemas";
import { HrAuditService } from "./hr-audit.service";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import { hrJobLevels, hrJobRoles } from "../../../db/schema/hr/core-org";
import { assertActiveOrgUnit } from "../../../common/org/sync-org-unit-placement";

type LifecycleStatus = typeof hrEmploymentLifecycleStatusEnum.enumValues[number];

const ALLOWED_TRANSITIONS: Record<LifecycleStatus, LifecycleStatus[]> = {
  CANDIDATE: ["PRE_JOINING", "EXITED"],
  PRE_JOINING: ["ONBOARDING", "EXITED"],
  ONBOARDING: ["ACTIVE", "PROBATION", "EXITED"],
  ACTIVE: ["PROBATION", "NOTICE", "SUSPENDED", "EXITED"],
  PROBATION: ["CONFIRMED", "ACTIVE", "NOTICE", "EXITED"],
  CONFIRMED: ["NOTICE", "SUSPENDED", "EXITED"],
  NOTICE: ["EXITED", "ACTIVE"],
  EXITED: ["ALUMNI"],
  ALUMNI: [],
  SUSPENDED: ["ACTIVE", "NOTICE", "EXITED"],
};

const EMPLOYMENT_VIEW_COLUMNS = {
  id: hrEmployments.id,
  orgId: hrEmployments.orgId,
  personId: hrEmployments.personId,
  employeeNumber: hrEmployments.employeeNumber,
  lifecycleStatus: hrEmployments.lifecycleStatus,
  workerType: hrEmployments.workerType,
  departmentId: hrEmployments.departmentId,
  jobRoleId: hrEmployments.jobRoleId,
  jobLevelId: hrEmployments.jobLevelId,
  employmentTypeId: hrEmployments.employmentTypeId,
  locationId: hrEmployments.locationId,
  designation: hrEmployments.designation,
  joiningDate: hrEmployments.joiningDate,
  probationEndDate: hrEmployments.probationEndDate,
  confirmationDate: hrEmployments.confirmationDate,
  noticeStartDate: hrEmployments.noticeStartDate,
  expectedLastDay: hrEmployments.expectedLastDay,
  lastWorkingDay: hrEmployments.lastWorkingDay,
  isPrimary: hrEmployments.isPrimary,
  createdAt: hrEmployments.createdAt,
  updatedAt: hrEmployments.updatedAt,
};

@Injectable()
export class HrEmploymentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  private async assertReferences(
    orgId: string,
    input: Partial<
      Pick<
        CreateEmploymentInput,
        | "personId"
        | "departmentId"
        | "locationId"
        | "jobRoleId"
        | "jobLevelId"
        | "employmentTypeId"
      >
    >,
  ): Promise<void> {
    const checks: Array<Promise<unknown>> = [];

    if (input.personId !== undefined) {
      checks.push(
        this.db
          .select({ id: hrPeople.id })
          .from(hrPeople)
          .where(
            and(
              eq(hrPeople.id, input.personId),
              eq(hrPeople.orgId, orgId),
              isNull(hrPeople.deletedAt),
            ),
          )
          .limit(1)
          .then(([person]) => {
            if (!person) throw new BadRequestException("Invalid employee selection.");
          }),
      );
    }
    if (input.departmentId !== undefined) {
      checks.push(assertActiveOrgUnit(this.db, orgId, input.departmentId, "DEPARTMENT"));
    }
    if (input.locationId !== undefined) {
      checks.push(assertActiveOrgUnit(this.db, orgId, input.locationId, "LOCATION"));
    }
    if (input.jobRoleId !== undefined) {
      checks.push(this.assertActiveJobRole(orgId, input.jobRoleId));
    }
    if (input.jobLevelId !== undefined) {
      checks.push(this.assertActiveJobLevel(orgId, input.jobLevelId));
    }
    if (input.employmentTypeId !== undefined) {
      throw new BadRequestException(
        "Employment type IDs are not supported by the current catalog. Use workerType instead.",
      );
    }

    await Promise.all(checks);
  }

  private async assertActiveJobRole(orgId: string, jobRoleId: number): Promise<void> {
    const [jobRole] = await this.db
      .select({ id: hrJobRoles.id })
      .from(hrJobRoles)
      .where(
        and(
          eq(hrJobRoles.id, jobRoleId),
          eq(hrJobRoles.orgId, orgId),
          eq(hrJobRoles.isActive, true),
        ),
      )
      .limit(1);
    if (!jobRole) throw new BadRequestException("Invalid job role selection.");
  }

  private async assertActiveJobLevel(orgId: string, jobLevelId: number): Promise<void> {
    const [jobLevel] = await this.db
      .select({ id: hrJobLevels.id })
      .from(hrJobLevels)
      .where(
        and(
          eq(hrJobLevels.id, jobLevelId),
          eq(hrJobLevels.orgId, orgId),
          eq(hrJobLevels.isActive, true),
        ),
      )
      .limit(1);
    if (!jobLevel) throw new BadRequestException("Invalid job level selection.");
  }

  async getOne(
    orgId: string,
    actorUserId: string,
    employmentId: number,
    scope: DataScope,
  ) {
    const [employment] = await this.db
      .select(EMPLOYMENT_VIEW_COLUMNS)
      .from(hrEmployments)
      .innerJoin(
        hrPeople,
        and(
          eq(hrPeople.orgId, hrEmployments.orgId),
          eq(hrPeople.id, hrEmployments.personId),
        ),
      )
      .where(
        and(
          eq(hrEmployments.id, employmentId),
          eq(hrEmployments.orgId, orgId),
          isNull(hrEmployments.deletedAt),
          eq(hrPeople.orgId, orgId),
          isNull(hrPeople.deletedAt),
          applyScope(scope, orgId, actorUserId, {
            ownerColumn: hrPeople.userId,
          }),
        ),
      )
      .limit(1);
    if (!employment) throw new NotFoundException("Employment not found");
    return employment;
  }

  private async getOneForMutation(orgId: string, employmentId: number) {
    const employment = await this.db.query.hrEmployments.findFirst({
      where: and(
        eq(hrEmployments.id, employmentId),
        eq(hrEmployments.orgId, orgId),
        isNull(hrEmployments.deletedAt),
      ),
    });
    if (!employment) throw new NotFoundException("Employment not found");
    return employment;
  }

  async create(orgId: string, actorId: string, input: CreateEmploymentInput) {
    await this.assertReferences(orgId, input);
    const [existing] = await this.db
      .select({ id: hrEmployments.id })
      .from(hrEmployments)
      .where(
        and(
          eq(hrEmployments.orgId, orgId),
          eq(hrEmployments.employeeNumber, input.employeeNumber),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .limit(1);
    if (existing) throw new ConflictException("Employee number already in use in this organization");

    // `is_primary` defaults to true and nothing here used to override it, so a
    // person who already had a primary employment ended up with two. The
    // standard directory join (organization_members -> users -> live hr_people
    // -> primary hr_employments) has no DISTINCT, so a second live primary
    // returns that employee twice from GET /hr/employees, shortens the keyset
    // page by one real employee, and adds one to every count()-based headcount.
    // hr_employments is plural per person by design, so the second employment
    // is created as non-primary rather than refused — first primary wins.
    const [existingPrimary] = await this.db
      .select({ id: hrEmployments.id })
      .from(hrEmployments)
      .where(
        and(
          eq(hrEmployments.orgId, orgId),
          eq(hrEmployments.personId, input.personId),
          eq(hrEmployments.isPrimary, true),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .limit(1);

    const [created] = await this.db
      .insert(hrEmployments)
      .values({
        orgId,
        personId: input.personId,
        isPrimary: !existingPrimary,
        employeeNumber: input.employeeNumber,
        lifecycleStatus: input.lifecycleStatus,
        workerType: input.workerType,
        departmentId: input.departmentId ?? null,
        jobRoleId: input.jobRoleId ?? null,
        jobLevelId: input.jobLevelId ?? null,
        employmentTypeId: input.employmentTypeId ?? null,
        locationId: input.locationId ?? null,
        designation: input.designation ?? null,
        joiningDate: input.joiningDate ?? null,
        probationEndDate: input.probationEndDate ?? null,
      })
      .returning();

    if (!created) throw new Error("Failed to create employment");

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_employments",
      entityId: String(created.id),
      action: "created",
      after: created,
    });

    return created;
  }

  async update(orgId: string, employmentId: number, actorId: string, input: UpdateEmploymentInput) {
    const existing = await this.getOneForMutation(orgId, employmentId);
    await this.assertReferences(orgId, input);

    if (input.employeeNumber && input.employeeNumber !== existing.employeeNumber) {
      const [dup] = await this.db
        .select({ id: hrEmployments.id })
        .from(hrEmployments)
        .where(
          and(
            eq(hrEmployments.orgId, orgId),
            eq(hrEmployments.employeeNumber, input.employeeNumber),
            isNull(hrEmployments.deletedAt),
          ),
        )
        .limit(1);
      if (dup && dup.id !== employmentId) {
        throw new ConflictException("Employee number already in use in this organization");
      }
    }

    const [updated] = await this.db
      .update(hrEmployments)
      .set({
        ...(input.employeeNumber !== undefined && { employeeNumber: input.employeeNumber }),
        ...(input.workerType !== undefined && { workerType: input.workerType }),
        ...(input.departmentId !== undefined && { departmentId: input.departmentId }),
        ...(input.jobRoleId !== undefined && { jobRoleId: input.jobRoleId }),
        ...(input.jobLevelId !== undefined && { jobLevelId: input.jobLevelId }),
        ...(input.employmentTypeId !== undefined && { employmentTypeId: input.employmentTypeId }),
        ...(input.locationId !== undefined && { locationId: input.locationId }),
        ...(input.designation !== undefined && { designation: input.designation }),
        ...(input.joiningDate !== undefined && { joiningDate: input.joiningDate }),
        ...(input.probationEndDate !== undefined && { probationEndDate: input.probationEndDate }),
      })
      .where(and(eq(hrEmployments.id, employmentId), eq(hrEmployments.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Employment not found");

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_employments",
      entityId: String(employmentId),
      action: "updated",
      before: existing,
      after: updated,
    });

    return updated;
  }

  async transition(
    orgId: string,
    employmentId: number,
    actorId: string,
    input: TransitionStatusInput,
    tx?: Db,
  ) {
    if (tx) return this.transitionInTransaction(tx, orgId, employmentId, actorId, input);
    return this.db.transaction((transaction) =>
      this.transitionInTransaction(transaction, orgId, employmentId, actorId, input),
    );
  }

  private async resolveActorMembershipId(
    tx: Db,
    orgId: string,
    actorId: string,
  ): Promise<number | null> {
    const [row] = await tx
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, actorId),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }

  private async transitionInTransaction(
    tx: Db,
    orgId: string,
    employmentId: number,
    actorId: string,
    input: TransitionStatusInput,
  ) {
    const [existing] = await tx
      .select()
      .from(hrEmployments)
      .where(
        and(
          eq(hrEmployments.id, employmentId),
          eq(hrEmployments.orgId, orgId),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .limit(1)
      .for("update");
    if (!existing) throw new NotFoundException("Employment not found.");
    const fromStatus: LifecycleStatus = existing.lifecycleStatus;
    const toStatus: LifecycleStatus = input.toStatus;

    if (fromStatus === toStatus) {
      return existing;
    }

    const allowed = ALLOWED_TRANSITIONS[fromStatus] ?? [];
    if (!allowed.includes(toStatus)) {
      throw new BadRequestException(
        `Transition from ${fromStatus} to ${toStatus} is not allowed`,
      );
    }

    const extra: Partial<typeof hrEmployments.$inferInsert> = {
      lifecycleStatus: toStatus,
    };
    if (toStatus === "CONFIRMED") {
      extra.confirmationDate = input.effectiveDate ?? new Date().toISOString().slice(0, 10);
    }
    if (toStatus === "PROBATION" && input.effectiveDate) {
      extra.probationEndDate = existing.probationEndDate ?? undefined;
    }

    const actorMembershipId = await this.resolveActorMembershipId(tx, orgId, actorId);
    await tx.insert(hrEmploymentHistory).values({
      orgId,
      employmentId,
      fromStatus,
      toStatus,
      reason: input.reason ?? null,
      notes: input.notes ?? null,
      effectiveDate: input.effectiveDate ?? null,
      createdByMembershipId: actorMembershipId,
    });

    const [updated] = await tx
      .update(hrEmployments)
      .set({
        ...extra,
        rowVersion: sql`${hrEmployments.rowVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(hrEmployments.id, employmentId),
          eq(hrEmployments.orgId, orgId),
          eq(hrEmployments.lifecycleStatus, fromStatus),
          eq(hrEmployments.rowVersion, existing.rowVersion),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .returning();
    if (!updated) throw new ConflictException("The employment was updated by another request.");

    await this.audit.log(
      {
        orgId,
        actorId,
        actorMembershipId,
        entityType: "hr_employments",
        entityId: String(employmentId),
        action: `status.transition.${fromStatus}.to.${toStatus}`,
        before: { lifecycleStatus: fromStatus },
        after: { lifecycleStatus: toStatus, reason: input.reason ?? null },
      },
      tx,
    );

    return updated;
  }

  async remove(orgId: string, employmentId: number, actorId: string) {
    const existing = await this.getOneForMutation(orgId, employmentId);

    await this.db
      .update(hrEmployments)
      .set({ deletedAt: new Date() })
      .where(and(eq(hrEmployments.id, employmentId), eq(hrEmployments.orgId, orgId)));

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_employments",
      entityId: String(employmentId),
      action: "deleted",
      before: existing,
    });

    return { success: true };
  }
}
