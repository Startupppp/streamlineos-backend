import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { getPostgresErrorCode } from "../../../common/db/postgres-error";
import { logger } from "../../../common/logger/logger.service";
import {
  employeeSalaryProfiles,
  employeeSalaryProfileComponents,
  organizationMembers,
} from "../../../db/schema";
import {
  assertPayrollPayeeEligible,
  assertPayrollWorkerPayeeEligible,
} from "../lib/payroll-payee-eligibility";
import type { DataScope } from "../../access/access.types";
import type { ListProfilesQuery, CreateProfileInput, PatchProfileInput } from "./dto/runs.schemas";
import { AuditService } from "../../../common/audit/audit.service";
import { SalaryProfilesRepository } from "./salary-profiles.repository";

@Injectable()
export class ProfilesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly profiles: SalaryProfilesRepository,
  ) {}

  async listProfiles(orgId: string, query: ListProfilesQuery, scope: DataScope, userId: string) {
    return this.profiles.list(orgId, query, scope, userId);
  }

  private async assertEmployeeInOrg(orgId: string, employeeUserId: string): Promise<void> {
    const member = await this.db.query.organizationMembers.findFirst({
      columns: { id: true },
      where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, employeeUserId)),
    });
    if (!member) throw new NotFoundException("Employee not found in this organization");
  }

  async getProfile(orgId: string, employeeUserId: string) {
    await this.assertEmployeeInOrg(orgId, employeeUserId);
    return this.profiles.findByUser(orgId, employeeUserId);
  }

  private async assertNoDateOverlapForWorker(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    orgId: string,
    workerId: string,
    effectiveFrom: string,
    excludeProfileId?: number,
  ): Promise<void> {
    const sameDayConditions = [
      eq(employeeSalaryProfiles.orgId, orgId),
      eq(employeeSalaryProfiles.workerId, workerId),
      eq(employeeSalaryProfiles.effectiveFrom, effectiveFrom),
    ];
    if (excludeProfileId != null) {
      sameDayConditions.push(ne(employeeSalaryProfiles.id, excludeProfileId));
    }
    const sameDay = await tx
      .select({ id: employeeSalaryProfiles.id })
      .from(employeeSalaryProfiles)
      .where(and(...sameDayConditions))
      .limit(1);

    if (sameDay[0]) {
      throw new ConflictException(
        `A salary profile already exists for this worker effective ${effectiveFrom}`,
      );
    }
  }

  async createProfileByWorker(
    orgId: string,
    workerId: string,
    actorId: string,
    body: CreateProfileInput,
  ) {
    const subject = await assertPayrollWorkerPayeeEligible(
      this.db,
      orgId,
      workerId,
      "Worker is not eligible for payroll in this organization",
    );

    if (body.components && body.components.length > 0) {
      const ids = body.components.map((c) => c.componentId);
      if (new Set(ids).size !== ids.length) {
        throw new BadRequestException("Duplicate component assignment on profile is not allowed");
      }
    }

    return this.db.transaction(async (tx) => {
      const today = new Date().toISOString().slice(0, 10);
      const isFutureDated = body.effectiveFrom > today;

      await this.assertNoDateOverlapForWorker(tx, orgId, workerId, body.effectiveFrom);

      if (!isFutureDated) {
        const overlapping = await tx
          .select({ id: employeeSalaryProfiles.id })
          .from(employeeSalaryProfiles)
          .where(
            and(
              eq(employeeSalaryProfiles.orgId, orgId),
              eq(employeeSalaryProfiles.workerId, workerId),
              eq(employeeSalaryProfiles.status, "ACTIVE"),
            ),
          )
          .limit(1);

        if (overlapping[0]) {
          const dayBefore = new Date(body.effectiveFrom);
          dayBefore.setDate(dayBefore.getDate() - 1);
          const effectiveTo = dayBefore.toISOString().slice(0, 10);

          await tx
            .update(employeeSalaryProfiles)
            .set({ status: "SUPERSEDED", effectiveTo })
            .where(eq(employeeSalaryProfiles.id, overlapping[0].id));
        }
      }

      let inserted: typeof employeeSalaryProfiles.$inferSelect | undefined;
      try {
        const [row] = await tx
          .insert(employeeSalaryProfiles)
          .values({
            orgId,
            userId: subject.userId,
            workerId,
            workerType: body.workerType ?? "CONTRACTOR",
            currency: body.currency ?? "INR",
            payoutCurrency: body.payoutCurrency,
            taxRegime: body.taxRegime,
            costCenter: body.costCenter,
            annualCtc: body.annualCtc,
            status: isFutureDated ? "UPCOMING" : "ACTIVE",
            effectiveFrom: body.effectiveFrom,
            createdBy: actorId,
          })
          .returning();
        inserted = row;
      } catch (err) {
        if (getPostgresErrorCode(err) !== "23505") {
          logger.error("profiles.createWorkerProfile: insert failed unexpectedly", {
            orgId,
            cause: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
        throw new ConflictException(
          `A salary profile already exists for this worker effective ${body.effectiveFrom}`,
        );
      }

      if (!inserted) throw new Error("Failed to insert profile");

      if (body.components && body.components.length > 0) {
        await tx.insert(employeeSalaryProfileComponents).values(
          body.components.map((c, idx) => ({
            orgId,
            profileId: inserted.id,
            componentId: c.componentId,
            calcMethodOverride: c.calcMethodOverride,
            amount: c.amount,
            percent: c.percent,
            formulaOverride: c.formulaOverride,
            sortOrder: idx,
          })),
        );
      }

      this.audit.log({
        action: "payroll.salary_profile_created",
        userId: actorId,
        orgId,
        targetId: workerId,
        targetType: "worker",
        metadata: {
          profileId: inserted.id,
          annualCtc: body.annualCtc,
          status: isFutureDated ? "UPCOMING" : "ACTIVE",
          linkedUserId: subject.userId,
        },
      });

      return { profileId: inserted.id };
    });
  }

  async getProfileByWorker(orgId: string, workerId: string) {
    return this.profiles.findByWorker(orgId, workerId);
  }

  private async assertNoDateOverlap(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    orgId: string,
    employeeUserId: string,
    effectiveFrom: string,
    excludeProfileId?: number,
  ): Promise<void> {
    const sameDayConditions = [
      eq(employeeSalaryProfiles.orgId, orgId),
      eq(employeeSalaryProfiles.userId, employeeUserId),
      eq(employeeSalaryProfiles.effectiveFrom, effectiveFrom),
    ];
    if (excludeProfileId != null)
      sameDayConditions.push(ne(employeeSalaryProfiles.id, excludeProfileId));
    const sameDay = await tx
      .select({ id: employeeSalaryProfiles.id })
      .from(employeeSalaryProfiles)
      .where(and(...sameDayConditions))
      .limit(1);

    if (sameDay[0])
      throw new ConflictException(
        `A salary profile already exists for this employee effective ${effectiveFrom}`,
      );
  }

  async createProfile(orgId: string, employeeUserId: string, actorId: string, body: CreateProfileInput) {
    await assertPayrollPayeeEligible(
      this.db,
      orgId,
      employeeUserId,
      "Person is not eligible for payroll in this organization",
    );

    if (body.components && body.components.length > 0) {
      const ids = body.components.map((c) => c.componentId);
      if (new Set(ids).size !== ids.length) {
        throw new BadRequestException("Duplicate component assignment on profile is not allowed");
      }
    }

    return this.db.transaction(async (tx) => {
      const today = new Date().toISOString().slice(0, 10);
      const isFutureDated = body.effectiveFrom > today;

      await this.assertNoDateOverlap(tx, orgId, employeeUserId, body.effectiveFrom);

      if (!isFutureDated) {
        const overlapping = await tx
          .select({ id: employeeSalaryProfiles.id })
          .from(employeeSalaryProfiles)
          .where(
            and(
              eq(employeeSalaryProfiles.orgId, orgId),
              eq(employeeSalaryProfiles.userId, employeeUserId),
              eq(employeeSalaryProfiles.status, "ACTIVE"),
            ),
          )
          .limit(1);

        if (overlapping[0]) {
          const dayBefore = new Date(body.effectiveFrom);
          dayBefore.setDate(dayBefore.getDate() - 1);
          const effectiveTo = dayBefore.toISOString().slice(0, 10);

          await tx
            .update(employeeSalaryProfiles)
            .set({ status: "SUPERSEDED", effectiveTo })
            .where(eq(employeeSalaryProfiles.id, overlapping[0].id));
        }
      }

      let inserted: typeof employeeSalaryProfiles.$inferSelect | undefined;
      try {
        const [row] = await tx
          .insert(employeeSalaryProfiles)
          .values({
            orgId,
            userId: employeeUserId,
            workerType: body.workerType ?? "EMPLOYEE",
            currency: body.currency ?? "INR",
            payoutCurrency: body.payoutCurrency,
            taxRegime: body.taxRegime,
            costCenter: body.costCenter,
            annualCtc: body.annualCtc,
            status: isFutureDated ? "UPCOMING" : "ACTIVE",
            effectiveFrom: body.effectiveFrom,
            createdBy: actorId,
          })
          .returning();
        inserted = row;
      } catch (err) {
        if (getPostgresErrorCode(err) !== "23505") {
          logger.error("profiles.createEmployeeProfile: insert failed unexpectedly", {
            orgId,
            cause: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
        throw new ConflictException(
          `A salary profile already exists for this employee effective ${body.effectiveFrom}`,
        );
      }

      if (!inserted) throw new Error("Failed to insert profile");
      const profile = inserted;

      if (body.components && body.components.length > 0) {
        try {
          await tx.insert(employeeSalaryProfileComponents).values(
            body.components.map((c, idx) => ({
              orgId,
              profileId: profile.id,
              componentId: c.componentId,
              calcMethodOverride: c.calcMethodOverride,
              amount: c.amount,
              percent: c.percent,
              formulaOverride: c.formulaOverride,
              sortOrder: idx,
            })),
          );
        } catch (err) {
          if (getPostgresErrorCode(err) !== "23505") {
            logger.error("profiles.createProfile: component insert failed unexpectedly", {
              orgId,
              cause: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
          throw new ConflictException("Duplicate component assignment on profile is not allowed");
        }
      }

      this.audit.log({
        action: "payroll.salary_profile_created",
        userId: actorId,
        orgId,
        targetId: employeeUserId,
        targetType: "employee",
        metadata: { profileId: inserted.id, annualCtc: body.annualCtc, status: isFutureDated ? "UPCOMING" : "ACTIVE" },
      });

      return { profileId: inserted.id };
    });
  }

  async patchProfile(orgId: string, employeeUserId: string, profileId: number, body: PatchProfileInput, actorId: string) {
    return this.patchProfileForSubject(orgId, employeeUserId, profileId, body, actorId, "employee");
  }

  async listHistory(orgId: string, employeeUserId: string) {
    await this.assertEmployeeInOrg(orgId, employeeUserId);
    return this.profiles.historyByUser(orgId, employeeUserId);
  }

  async listHistoryByWorker(orgId: string, workerId: string) {
    return this.profiles.historyByWorker(orgId, workerId);
  }

  async patchProfileByWorker(
    orgId: string,
    workerId: string,
    profileId: number,
    body: PatchProfileInput,
    actorId: string,
  ) {
    return this.patchProfileForSubject(orgId, workerId, profileId, body, actorId, "worker");
  }

  private async patchProfileForSubject(
    orgId: string,
    subjectId: string,
    profileId: number,
    body: PatchProfileInput,
    actorId: string,
    subjectType: "employee" | "worker",
  ) {
    const subjectCondition = subjectType === "employee"
      ? eq(employeeSalaryProfiles.userId, subjectId)
      : eq(employeeSalaryProfiles.workerId, subjectId);
    const existing = await this.db
      .select({
        id: employeeSalaryProfiles.id,
        status: employeeSalaryProfiles.status,
        annualCtc: employeeSalaryProfiles.annualCtc,
      })
      .from(employeeSalaryProfiles)
      .where(
        and(
          eq(employeeSalaryProfiles.id, profileId),
          eq(employeeSalaryProfiles.orgId, orgId),
          subjectCondition,
        ),
      )
      .limit(1);

    if (!existing[0]) return null;
    if (existing[0].status === "SUPERSEDED") return { ok: false, reason: "superseded" };

    const oldAnnualCtc = existing[0].annualCtc;
    const updateData: Partial<typeof employeeSalaryProfiles.$inferInsert> = {};
    if (body.annualCtc !== undefined) updateData.annualCtc = body.annualCtc;
    if (body.workerType !== undefined) updateData.workerType = body.workerType;
    if (body.currency !== undefined) updateData.currency = body.currency;
    if (body.payoutCurrency !== undefined) updateData.payoutCurrency = body.payoutCurrency;
    if (body.taxRegime !== undefined) updateData.taxRegime = body.taxRegime;
    if (body.costCenter !== undefined) updateData.costCenter = body.costCenter;

    await this.db.transaction(async (tx) => {
      await tx
        .update(employeeSalaryProfiles)
        .set(updateData)
        .where(and(eq(employeeSalaryProfiles.id, profileId), eq(employeeSalaryProfiles.orgId, orgId)));

      if (body.components && body.components.length > 0) {
        await tx
          .delete(employeeSalaryProfileComponents)
          .where(
            and(
              eq(employeeSalaryProfileComponents.profileId, profileId),
              eq(employeeSalaryProfileComponents.orgId, orgId),
            ),
          );

        await tx.insert(employeeSalaryProfileComponents).values(
          body.components.map((c, idx) => ({
            orgId,
            profileId,
            componentId: c.componentId,
            calcMethodOverride: c.calcMethodOverride,
            amount: c.amount,
            percent: c.percent,
            formulaOverride: c.formulaOverride,
            sortOrder: idx,
          })),
        );
      }
    });

    this.audit.log({
      action: "payroll.salary_profile_updated",
      userId: actorId,
      orgId,
      targetId: subjectId,
      targetType: subjectType,
      metadata: {
        profileId,
        oldAnnualCtc,
        newAnnualCtc: body.annualCtc ?? oldAnnualCtc,
      },
    });

    return { ok: true };
  }
}
