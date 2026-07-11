import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, isNull, lte, sql } from "drizzle-orm";
import {
  hrEffectiveDatedChanges,
  hrEmployments,
} from "../../db/schema/hr/core-people";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type {
  CreateEffectiveDateChangeInput,
  ListEffectiveDateChangesInput,
} from "./dto/hr-core.schemas";
import { HrAuditService } from "./hr-audit.service";

@Injectable()
export class HrEffectiveChangesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async create(orgId: string, actorId: string, input: CreateEffectiveDateChangeInput) {
    const [employment] = await this.db
      .select({ id: hrEmployments.id })
      .from(hrEmployments)
      .where(
        and(
          eq(hrEmployments.id, input.employmentId),
          eq(hrEmployments.orgId, orgId),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .limit(1);
    if (!employment) throw new NotFoundException("Employment not found");

    const [created] = await this.db
      .insert(hrEffectiveDatedChanges)
      .values({
        orgId,
        employmentId: input.employmentId,
        changeType: input.changeType,
        oldValue: (input.oldValue as never) ?? null,
        newValue: input.newValue as never,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        notes: input.notes ?? null,
        createdBy: actorId,
        status: "draft",
      })
      .returning();

    if (!created) throw new Error("Failed to create effective-dated change");

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_effective_dated_changes",
      entityId: String(created.id),
      action: "created",
      after: created,
    });

    return created;
  }

  async list(orgId: string, input: ListEffectiveDateChangesInput) {
    const { page, limit, employmentId, changeType, status } = input;
    const offset = (page - 1) * limit;

    const conditions = [eq(hrEffectiveDatedChanges.orgId, orgId)];
    if (employmentId) conditions.push(eq(hrEffectiveDatedChanges.employmentId, employmentId));
    if (changeType) conditions.push(eq(hrEffectiveDatedChanges.changeType, changeType as never));
    if (status) conditions.push(eq(hrEffectiveDatedChanges.status, status));

    const where = and(...conditions);

    const [data, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrEffectiveDatedChanges)
        .where(where)
        .orderBy(hrEffectiveDatedChanges.effectiveFrom)
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrEffectiveDatedChanges).where(where),
    ]);

    const total = totalResult[0]?.total ?? 0;

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async approve(orgId: string, changeId: number, actorId: string) {
    const [change] = await this.db
      .select()
      .from(hrEffectiveDatedChanges)
      .where(
        and(
          eq(hrEffectiveDatedChanges.id, changeId),
          eq(hrEffectiveDatedChanges.orgId, orgId),
        ),
      )
      .limit(1);

    if (!change) throw new NotFoundException("Effective-dated change not found");

    const [updated] = await this.db
      .update(hrEffectiveDatedChanges)
      .set({
        status: "approved",
        approvedBy: actorId,
        approvedAt: new Date(),
      })
      .where(and(eq(hrEffectiveDatedChanges.id, changeId), eq(hrEffectiveDatedChanges.orgId, orgId)))
      .returning();

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_effective_dated_changes",
      entityId: String(changeId),
      action: "approved",
      before: { status: change.status },
      after: { status: "approved" },
    });

    return updated;
  }

  async applyDueChanges(orgId: string, asOfDate?: string): Promise<{ applied: number }> {
    const cutoff = asOfDate ? new Date(asOfDate) : new Date();

    const dueChanges = await this.db
      .select()
      .from(hrEffectiveDatedChanges)
      .where(
        and(
          eq(hrEffectiveDatedChanges.orgId, orgId),
          eq(hrEffectiveDatedChanges.status, "approved"),
          lte(hrEffectiveDatedChanges.effectiveFrom, cutoff.toISOString().slice(0, 10)),
          isNull(hrEffectiveDatedChanges.appliedAt),
        ),
      );

    if (dueChanges.length === 0) return { applied: 0 };

    let applied = 0;

    for (const change of dueChanges) {
      await this.db.transaction(async (tx) => {
        const newVal = change.newValue as Record<string, unknown> | null;
        if (!newVal) return;

        if (change.changeType === "department" && typeof newVal["departmentId"] === "number") {
          await tx
            .update(hrEmployments)
            .set({ departmentId: newVal["departmentId"] as number })
            .where(
              and(
                eq(hrEmployments.id, change.employmentId),
                eq(hrEmployments.orgId, orgId),
              ),
            );
        } else if (change.changeType === "designation" && typeof newVal["designation"] === "string") {
          await tx
            .update(hrEmployments)
            .set({ designation: newVal["designation"] as string })
            .where(
              and(
                eq(hrEmployments.id, change.employmentId),
                eq(hrEmployments.orgId, orgId),
              ),
            );
        } else if (change.changeType === "job_level" && typeof newVal["jobLevelId"] === "number") {
          await tx
            .update(hrEmployments)
            .set({ jobLevelId: newVal["jobLevelId"] as number })
            .where(
              and(
                eq(hrEmployments.id, change.employmentId),
                eq(hrEmployments.orgId, orgId),
              ),
            );
        } else if (change.changeType === "location" && typeof newVal["locationId"] === "number") {
          await tx
            .update(hrEmployments)
            .set({ locationId: newVal["locationId"] as number })
            .where(
              and(
                eq(hrEmployments.id, change.employmentId),
                eq(hrEmployments.orgId, orgId),
              ),
            );
        } else if (change.changeType === "employment_type" && typeof newVal["employmentTypeId"] === "number") {
          await tx
            .update(hrEmployments)
            .set({ employmentTypeId: newVal["employmentTypeId"] as number })
            .where(
              and(
                eq(hrEmployments.id, change.employmentId),
                eq(hrEmployments.orgId, orgId),
              ),
            );
        }

        await tx
          .update(hrEffectiveDatedChanges)
          .set({ status: "applied", appliedAt: sql`now()` })
          .where(eq(hrEffectiveDatedChanges.id, change.id));
      });

      applied++;
    }

    return { applied };
  }
}
