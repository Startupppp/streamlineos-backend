import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  hrBenefitEnrollments,
  hrBenefitPlans,
  hrDependents,
} from "../../db/schema/hr/benefits";
import { HrPolicyEvaluationService } from "../hr-policies/hr-policy-evaluation.service";
import type { EnrollInput, WaiveInput, CreateDependentInput, PatchDependentInput } from "./dto/benefits.schemas";

@Injectable()
export class HrBenefitsEnrollmentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly policyEval: HrPolicyEvaluationService,
  ) {}

  async checkEligibility(orgId: string, planId: number, employeeId: string) {
    const [plan] = await this.db
      .select()
      .from(hrBenefitPlans)
      .where(and(eq(hrBenefitPlans.id, planId), eq(hrBenefitPlans.orgId, orgId)))
      .limit(1);

    if (!plan) throw new NotFoundException("Benefit plan not found");
    if (plan.status !== "active") return { eligible: false, reason: "Plan is not active" };

    const today = new Date().toISOString().split("T")[0]!;
    const policy = await this.policyEval.evaluatePolicy(orgId, employeeId, "payroll_eligibility", today);

    const eligible = policy !== null;
    return { eligible, planId, planName: plan.name, policy: policy?.rules ?? null };
  }

  async enroll(orgId: string, userId: string, data: EnrollInput) {
    const [plan] = await this.db
      .select()
      .from(hrBenefitPlans)
      .where(and(eq(hrBenefitPlans.id, data.planId), eq(hrBenefitPlans.orgId, orgId)))
      .limit(1);

    if (!plan || plan.status !== "active") {
      throw new BadRequestException("Benefit plan is not available for enrollment");
    }

    try {
      const [enrollment] = await this.db
        .insert(hrBenefitEnrollments)
        .values({
          orgId,
          planId: data.planId,
          userId,
          status: "active",
          effectiveFrom: data.effectiveFrom ?? null,
          dependentsCovered: data.dependentsCovered ?? 0,
        })
        .returning();
      return enrollment;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException("You are already enrolled in this plan");
      }
      throw err;
    }
  }

  async waive(orgId: string, userId: string, data: WaiveInput) {
    const [existing] = await this.db
      .select()
      .from(hrBenefitEnrollments)
      .where(
        and(
          eq(hrBenefitEnrollments.orgId, orgId),
          eq(hrBenefitEnrollments.userId, userId),
          eq(hrBenefitEnrollments.planId, data.planId),
        ),
      )
      .limit(1);

    if (existing) {
      const [updated] = await this.db
        .update(hrBenefitEnrollments)
        .set({ status: "waived", updatedAt: new Date() })
        .where(eq(hrBenefitEnrollments.id, existing.id))
        .returning();
      return updated;
    }

    const [enrollment] = await this.db
      .insert(hrBenefitEnrollments)
      .values({ orgId, planId: data.planId, userId, status: "waived" })
      .returning();
    return enrollment;
  }

  async getMyBenefits(orgId: string, userId: string) {
    const [enrollmentRows, dependents] = await Promise.all([
      this.db
        .select({
          enrollment: hrBenefitEnrollments,
          plan: hrBenefitPlans,
        })
        .from(hrBenefitEnrollments)
        .innerJoin(hrBenefitPlans, eq(hrBenefitPlans.id, hrBenefitEnrollments.planId))
        .where(
          and(
            eq(hrBenefitEnrollments.orgId, orgId),
            eq(hrBenefitEnrollments.userId, userId),
          ),
        )
        .orderBy(desc(hrBenefitEnrollments.enrolledAt))
        .limit(50),
      this.db
        .select()
        .from(hrDependents)
        .where(and(eq(hrDependents.orgId, orgId), eq(hrDependents.userId, userId)))
        .orderBy(hrDependents.name),
    ]);

    const enrollments = enrollmentRows.map((r) => ({ ...r.enrollment, plan: r.plan }));
    return { enrollments, dependents };
  }

  async listDependents(orgId: string, userId: string) {
    return this.db
      .select()
      .from(hrDependents)
      .where(and(eq(hrDependents.orgId, orgId), eq(hrDependents.userId, userId)))
      .orderBy(hrDependents.name);
  }

  async addDependent(orgId: string, userId: string, data: CreateDependentInput) {
    const [dep] = await this.db
      .insert(hrDependents)
      .values({ ...data, orgId, userId })
      .returning();
    return dep;
  }

  async updateDependent(orgId: string, userId: string, depId: number, data: PatchDependentInput) {
    const [existing] = await this.db
      .select()
      .from(hrDependents)
      .where(
        and(
          eq(hrDependents.id, depId),
          eq(hrDependents.orgId, orgId),
          eq(hrDependents.userId, userId),
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundException("Dependent not found");

    const [updated] = await this.db
      .update(hrDependents)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(hrDependents.id, depId))
      .returning();
    return updated;
  }

  async deleteDependent(orgId: string, userId: string, depId: number) {
    const [existing] = await this.db
      .select()
      .from(hrDependents)
      .where(
        and(
          eq(hrDependents.id, depId),
          eq(hrDependents.orgId, orgId),
          eq(hrDependents.userId, userId),
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundException("Dependent not found");

    await this.db
      .delete(hrDependents)
      .where(eq(hrDependents.id, depId));
    return { ok: true };
  }
}
