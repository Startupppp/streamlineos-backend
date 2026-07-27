import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, eq, isNull } from "drizzle-orm";
import {
  hrEmployments,
  hrEmploymentHistory,
  type hrEmploymentLifecycleStatusEnum,
} from "../../db/schema/hr/core-people";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type {
  CreateEmploymentInput,
  UpdateEmploymentInput,
  TransitionStatusInput,
} from "./dto/hr-core.schemas";
import { HrAuditService } from "./hr-audit.service";

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

@Injectable()
export class HrEmploymentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async list(orgId: string, opts: { page: number; limit: number }) {
    const { page, limit } = opts;
    const offset = (page - 1) * limit;
    const where = and(eq(hrEmployments.orgId, orgId), isNull(hrEmployments.deletedAt));

    const [data, totalResult] = await Promise.all([
      this.db
        .select({
          id: hrEmployments.id,
          orgId: hrEmployments.orgId,
          personId: hrEmployments.personId,
          employeeNumber: hrEmployments.employeeNumber,
          lifecycleStatus: hrEmployments.lifecycleStatus,
          workerType: hrEmployments.workerType,
          departmentId: hrEmployments.departmentId,
          designation: hrEmployments.designation,
          joiningDate: hrEmployments.joiningDate,
          isPrimary: hrEmployments.isPrimary,
          createdAt: hrEmployments.createdAt,
        })
        .from(hrEmployments)
        .where(where)
        .orderBy(hrEmployments.id)
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrEmployments).where(where),
    ]);

    const total = totalResult[0]?.total ?? 0;

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getOne(orgId: string, employmentId: number) {
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

    const [created] = await this.db
      .insert(hrEmployments)
      .values({
        orgId,
        personId: input.personId,
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
    const existing = await this.getOne(orgId, employmentId);

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

  async transition(orgId: string, employmentId: number, actorId: string, input: TransitionStatusInput) {
    const existing = await this.getOne(orgId, employmentId);
    const fromStatus = existing.lifecycleStatus as LifecycleStatus;
    const toStatus = input.toStatus as LifecycleStatus;

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

    const [updated] = await this.db.transaction(async (tx) => {
      await tx.insert(hrEmploymentHistory).values({
        orgId,
        employmentId,
        fromStatus,
        toStatus,
        reason: input.reason ?? null,
        notes: input.notes ?? null,
        effectiveDate: input.effectiveDate ?? null,
        createdBy: actorId,
      });

      return tx
        .update(hrEmployments)
        .set(extra)
        .where(and(eq(hrEmployments.id, employmentId), eq(hrEmployments.orgId, orgId)))
        .returning();
    });

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_employments",
      entityId: String(employmentId),
      action: `status.transition.${fromStatus}.to.${toStatus}`,
      before: { lifecycleStatus: fromStatus },
      after: { lifecycleStatus: toStatus, reason: input.reason ?? null },
    });

    return updated;
  }

  async remove(orgId: string, employmentId: number, actorId: string) {
    const existing = await this.getOne(orgId, employmentId);

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
