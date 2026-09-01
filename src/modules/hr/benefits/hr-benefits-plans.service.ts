import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, or, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrBenefitPlans,
  hrBenefitEnrollmentWindows,
} from "../../../db/schema/hr/benefits";
import type {
  CreateBenefitPlanInput,
  PatchBenefitPlanInput,
  CreateEnrollmentWindowInput,
  BenefitPlansQuery,
} from "./dto/benefits.schemas";

@Injectable()
export class HrBenefitsPlansService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listPlans(orgId: string, query: BenefitPlansQuery) {
    const { status, category, limit } = query;

    const conditions = [eq(hrBenefitPlans.orgId, orgId)];
    if (status) conditions.push(eq(hrBenefitPlans.status, status));
    if (category) conditions.push(eq(hrBenefitPlans.category, category));

    const rows = await this.db
      .select()
      .from(hrBenefitPlans)
      .where(and(...conditions))
      .orderBy(asc(hrBenefitPlans.name))
      .limit(limit);

    return { data: rows };
  }

  async getPlan(orgId: string, planId: number) {
    const [plan] = await this.db
      .select()
      .from(hrBenefitPlans)
      .where(and(eq(hrBenefitPlans.id, planId), eq(hrBenefitPlans.orgId, orgId)))
      .limit(1);

    if (!plan) throw new NotFoundException("Benefit plan not found");
    return plan;
  }

  async createPlan(orgId: string, data: CreateBenefitPlanInput) {
    try {
      const [plan] = await this.db
        .insert(hrBenefitPlans)
        .values({ ...data, orgId })
        .returning();
      return plan;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException("A benefit plan with this name already exists");
      }
      throw err;
    }
  }

  async updatePlan(orgId: string, planId: number, data: PatchBenefitPlanInput) {
    try {
      const [updated] = await this.db
        .update(hrBenefitPlans)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(hrBenefitPlans.id, planId), eq(hrBenefitPlans.orgId, orgId)))
        .returning();
      if (!updated) throw new NotFoundException("Benefit plan not found");
      return updated;
    } catch (err: unknown) {
      if (err instanceof NotFoundException) throw err;
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException("A benefit plan with this name already exists");
      }
      throw err;
    }
  }

  async deletePlan(orgId: string, planId: number) {
    const [deleted] = await this.db
      .delete(hrBenefitPlans)
      .where(and(eq(hrBenefitPlans.id, planId), eq(hrBenefitPlans.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Benefit plan not found");
    return { ok: true };
  }

  async listWindows(orgId: string) {
    return this.db
      .select()
      .from(hrBenefitEnrollmentWindows)
      .where(eq(hrBenefitEnrollmentWindows.orgId, orgId))
      .orderBy(desc(hrBenefitEnrollmentWindows.opensAt))
      .limit(50);
  }

  async createWindow(orgId: string, data: CreateEnrollmentWindowInput) {
    const [window] = await this.db
      .insert(hrBenefitEnrollmentWindows)
      .values({ ...data, opensAt: new Date(data.opensAt), closesAt: new Date(data.closesAt), orgId })
      .returning();
    return window;
  }

  async updateWindow(orgId: string, windowId: number, data: Partial<CreateEnrollmentWindowInput>) {
    const [existing] = await this.db
      .select()
      .from(hrBenefitEnrollmentWindows)
      .where(and(eq(hrBenefitEnrollmentWindows.id, windowId), eq(hrBenefitEnrollmentWindows.orgId, orgId)))
      .limit(1);

    if (!existing) throw new NotFoundException("Enrollment window not found");

    const { opensAt, closesAt, ...rest } = data;
    const [updated] = await this.db
      .update(hrBenefitEnrollmentWindows)
      .set({
        ...rest,
        ...(opensAt ? { opensAt: new Date(opensAt) } : {}),
        ...(closesAt ? { closesAt: new Date(closesAt) } : {}),
      })
      .where(and(eq(hrBenefitEnrollmentWindows.id, windowId), eq(hrBenefitEnrollmentWindows.orgId, orgId)))
      .returning();
    return updated;
  }

  /**
   * Enrollment windows are opt-in: a plan/org with none configured has no restriction (the
   * feature was never set up for it). Only enforced once at least one window row exists in
   * scope for this plan (plan-specific, or org-wide via a null planId).
   */
  async checkEnrollmentWindowOpen(orgId: string, planId: number): Promise<boolean> {
    const now = new Date();
    const windows = await this.db
      .select()
      .from(hrBenefitEnrollmentWindows)
      .where(
        and(
          eq(hrBenefitEnrollmentWindows.orgId, orgId),
          or(eq(hrBenefitEnrollmentWindows.planId, planId), isNull(hrBenefitEnrollmentWindows.planId)),
        ),
      );

    if (windows.length === 0) return true;
    return windows.some(
      (window) => window.status === "open" && window.opensAt <= now && window.closesAt >= now,
    );
  }
}
