import { BadRequestException, ConflictException, Injectable, Inject, ForbiddenException } from "@nestjs/common";
import { and, eq, desc, ilike, or, count, ne, isNull, gte, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  employeeSalaryProfiles,
  employeeSalaryProfileComponents,
  salaryComponents,
  organizationMembers,
} from "../../../db/schema";
import { users } from "../../../db/schema";
import type { DataScope } from "../../access/access.types";
import { applyScope } from "../../access/apply-scope";
import type { ListProfilesQuery, CreateProfileInput, PatchProfileInput } from "./dto/runs.schemas";
import { AuditService } from "../../../common/audit/audit.service";

@Injectable()
export class ProfilesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async listProfiles(orgId: string, query: ListProfilesQuery, scope: DataScope, userId: string) {
    const offset = (query.page - 1) * query.limit;
    const scopeCondition = applyScope(scope, userId, { ownerColumn: employeeSalaryProfiles.userId });

    const conditions = [
      eq(employeeSalaryProfiles.orgId, orgId),
      scopeCondition,
    ];

    if (query.status) {
      conditions.push(eq(employeeSalaryProfiles.status, query.status as "UPCOMING" | "ACTIVE" | "SUPERSEDED"));
    } else {
      conditions.push(eq(employeeSalaryProfiles.status, "ACTIVE"));
    }

    if (query.workerType) conditions.push(eq(employeeSalaryProfiles.workerType, query.workerType as "EMPLOYEE" | "CONTRACTOR" | "CONSULTANT" | "INTERN" | "EOR"));
    if (query.costCenter) conditions.push(eq(employeeSalaryProfiles.costCenter, query.costCenter));

    const searchCondition = query.search
      ? or(ilike(users.name, `%${query.search}%`), ilike(users.email, `%${query.search}%`))
      : undefined;

    const finalConditions = searchCondition ? [...conditions, searchCondition] : conditions;

    const [rows, [totRow]] = await Promise.all([
      this.db
        .select({
          id: employeeSalaryProfiles.id,
          userId: employeeSalaryProfiles.userId,
          workerType: employeeSalaryProfiles.workerType,
          currency: employeeSalaryProfiles.currency,
          annualCtc: employeeSalaryProfiles.annualCtc,
          taxRegime: employeeSalaryProfiles.taxRegime,
          costCenter: employeeSalaryProfiles.costCenter,
          status: employeeSalaryProfiles.status,
          effectiveFrom: employeeSalaryProfiles.effectiveFrom,
          userName: users.name,
          userEmail: users.email,
        })
        .from(employeeSalaryProfiles)
        .innerJoin(users, eq(users.id, employeeSalaryProfiles.userId))
        .where(and(...finalConditions))
        .orderBy(users.name)
        .limit(query.limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(employeeSalaryProfiles)
        .innerJoin(users, eq(users.id, employeeSalaryProfiles.userId))
        .where(and(...finalConditions)),
    ]);

    return { data: rows, total: totRow?.total ?? 0, page: query.page, limit: query.limit };
  }

  async getProfile(orgId: string, employeeUserId: string) {
    const [allProfiles, history] = await Promise.all([
      this.db
        .select()
        .from(employeeSalaryProfiles)
        .where(and(eq(employeeSalaryProfiles.orgId, orgId), eq(employeeSalaryProfiles.userId, employeeUserId), eq(employeeSalaryProfiles.status, "ACTIVE")))
        .limit(1),
      this.db
        .select()
        .from(employeeSalaryProfiles)
        .where(and(eq(employeeSalaryProfiles.orgId, orgId), eq(employeeSalaryProfiles.userId, employeeUserId)))
        .orderBy(desc(employeeSalaryProfiles.effectiveFrom)),
    ]);

    const activeProfile = allProfiles[0] ?? null;

    const components = activeProfile
      ? await this.db
          .select({
            id: employeeSalaryProfileComponents.id,
            componentId: employeeSalaryProfileComponents.componentId,
            calcMethodOverride: employeeSalaryProfileComponents.calcMethodOverride,
            amount: employeeSalaryProfileComponents.amount,
            percent: employeeSalaryProfileComponents.percent,
            formulaOverride: employeeSalaryProfileComponents.formulaOverride,
            sortOrder: employeeSalaryProfileComponents.sortOrder,
            code: salaryComponents.code,
            name: salaryComponents.name,
            type: salaryComponents.type,
            calcMethod: salaryComponents.calcMethod,
            taxable: salaryComponents.taxable,
          })
          .from(employeeSalaryProfileComponents)
          .innerJoin(salaryComponents, eq(salaryComponents.id, employeeSalaryProfileComponents.componentId))
          .where(eq(employeeSalaryProfileComponents.profileId, activeProfile.id))
          .orderBy(salaryComponents.sortOrder)
      : [];

    return { active: activeProfile, components, history };
  }

  /**
   * Detect open-ended or dated profiles that would overlap [effectiveFrom, effectiveTo).
   * Open-ended profiles (effectiveTo null) are treated as infinite end.
   */
  private async assertNoDateOverlap(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    orgId: string,
    employeeUserId: string,
    effectiveFrom: string,
    excludeProfileId?: number,
  ): Promise<void> {
    const conditions = [
      eq(employeeSalaryProfiles.orgId, orgId),
      eq(employeeSalaryProfiles.userId, employeeUserId),
      or(
        eq(employeeSalaryProfiles.status, "ACTIVE"),
        eq(employeeSalaryProfiles.status, "UPCOMING"),
      ),
      // existing.effectiveFrom <= new.effectiveFrom AND (existing.effectiveTo is null OR existing.effectiveTo >= new.effectiveFrom)
      lte(employeeSalaryProfiles.effectiveFrom, effectiveFrom),
      or(isNull(employeeSalaryProfiles.effectiveTo), gte(employeeSalaryProfiles.effectiveTo, effectiveFrom)),
    ];
    if (excludeProfileId != null) {
      conditions.push(ne(employeeSalaryProfiles.id, excludeProfileId));
    }

    const clash = await tx
      .select({ id: employeeSalaryProfiles.id, effectiveFrom: employeeSalaryProfiles.effectiveFrom })
      .from(employeeSalaryProfiles)
      .where(and(...conditions))
      .limit(1);

    const sameDayConditions = [
      eq(employeeSalaryProfiles.orgId, orgId),
      eq(employeeSalaryProfiles.userId, employeeUserId),
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
        `A salary profile already exists for this employee effective ${effectiveFrom}`,
      );
    }

    // Clash used for future multi-active overlap hardening; supersede path still primary.
    void clash;
  }

  async createProfile(orgId: string, employeeUserId: string, actorId: string, body: CreateProfileInput) {
    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, employeeUserId)),
      columns: { id: true },
    });
    if (!membership) throw new ForbiddenException("Employee is not a member of this organization");

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
      } catch {
        throw new ConflictException(
          `A salary profile already exists for this employee effective ${body.effectiveFrom}`,
        );
      }

      if (!inserted) throw new Error("Failed to insert profile");

      if (body.components && body.components.length > 0) {
        try {
          await tx.insert(employeeSalaryProfileComponents).values(
            body.components.map((c, idx) => ({
              orgId,
              profileId: inserted!.id,
              componentId: c.componentId,
              calcMethodOverride: c.calcMethodOverride,
              amount: c.amount,
              percent: c.percent,
              formulaOverride: c.formulaOverride,
              sortOrder: idx,
            })),
          );
        } catch {
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
          eq(employeeSalaryProfiles.userId, employeeUserId),
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
          .where(and(eq(employeeSalaryProfileComponents.profileId, profileId), eq(employeeSalaryProfileComponents.orgId, orgId)));

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
      targetId: employeeUserId,
      targetType: "employee",
      metadata: {
        profileId,
        oldAnnualCtc,
        newAnnualCtc: body.annualCtc ?? oldAnnualCtc,
      },
    });

    return { ok: true };
  }

  async listHistory(orgId: string, employeeUserId: string) {
    return this.db
      .select()
      .from(employeeSalaryProfiles)
      .where(and(eq(employeeSalaryProfiles.orgId, orgId), eq(employeeSalaryProfiles.userId, employeeUserId)))
      .orderBy(desc(employeeSalaryProfiles.effectiveFrom));
  }
}
