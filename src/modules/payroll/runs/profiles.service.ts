import { Injectable, Inject } from "@nestjs/common";
import { and, eq, desc, ilike, or, count, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  employeeSalaryProfiles,
  employeeSalaryProfileComponents,
  salaryComponents,
} from "../../../db/schema";
import { users } from "../../../db/schema";
import type { DataScope } from "../../access/access.types";
import { applyScope } from "../../access/apply-scope";
import type { ListProfilesQuery, CreateProfileInput, PatchProfileInput } from "./dto/runs.schemas";

@Injectable()
export class ProfilesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listProfiles(orgId: string, query: ListProfilesQuery, scope: DataScope, userId: string) {
    const offset = (query.page - 1) * query.limit;
    const scopeCondition = applyScope(scope, userId, { ownerColumn: employeeSalaryProfiles.userId });

    const conditions = [
      eq(employeeSalaryProfiles.orgId, orgId),
      eq(employeeSalaryProfiles.status, "ACTIVE"),
      scopeCondition,
    ];

    if (query.workerType) conditions.push(eq(employeeSalaryProfiles.workerType, query.workerType as "EMPLOYEE" | "CONTRACTOR" | "CONSULTANT" | "INTERN" | "EOR"));
    if (query.status) conditions.push(eq(employeeSalaryProfiles.status, query.status as "UPCOMING" | "ACTIVE" | "SUPERSEDED"));
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
    const [active, history] = await Promise.all([
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

    if (!active[0]) return null;

    const components = await this.db
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
      .where(eq(employeeSalaryProfileComponents.profileId, active[0].id))
      .orderBy(salaryComponents.sortOrder);

    return { profile: active[0], components, history };
  }

  async createProfile(orgId: string, employeeUserId: string, actorId: string, body: CreateProfileInput) {
    return this.db.transaction(async (tx) => {
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

      const [inserted] = await tx
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
          status: "ACTIVE",
          effectiveFrom: body.effectiveFrom,
          createdBy: actorId,
        })
        .returning();

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

      return { profileId: inserted.id };
    });
  }

  async patchProfile(orgId: string, employeeUserId: string, profileId: number, body: PatchProfileInput) {
    const existing = await this.db
      .select({ id: employeeSalaryProfiles.id, status: employeeSalaryProfiles.status })
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

    const updateData: Partial<typeof employeeSalaryProfiles.$inferInsert> = {};
    if (body.annualCtc !== undefined) updateData.annualCtc = body.annualCtc;
    if (body.workerType !== undefined) updateData.workerType = body.workerType;
    if (body.currency !== undefined) updateData.currency = body.currency;
    if (body.payoutCurrency !== undefined) updateData.payoutCurrency = body.payoutCurrency;
    if (body.taxRegime !== undefined) updateData.taxRegime = body.taxRegime;
    if (body.costCenter !== undefined) updateData.costCenter = body.costCenter;

    await this.db
      .update(employeeSalaryProfiles)
      .set(updateData)
      .where(eq(employeeSalaryProfiles.id, profileId));

    if (body.components && body.components.length > 0) {
      await this.db
        .delete(employeeSalaryProfileComponents)
        .where(eq(employeeSalaryProfileComponents.profileId, profileId));

      await this.db.insert(employeeSalaryProfileComponents).values(
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
