import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrBenefitEnrollments,
  hrBenefitPlans,
  hrDependents,
} from "../../../db/schema/hr/benefits";
import { HrPolicyEvaluationService } from "../policies/hr-policy-evaluation.service";
import { HrBenefitsPlansService } from "./hr-benefits-plans.service";
import type { EnrollInput, WaiveInput, CreateDependentInput, PatchDependentInput } from "./dto/benefits.schemas";

@Injectable()
export class HrBenefitsEnrollmentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly policyEval: HrPolicyEvaluationService,
    private readonly plans: HrBenefitsPlansService,
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

  async enroll(orgId: string, userId: string, membershipId: number | null, data: EnrollInput) {
    if (membershipId == null) throw new ForbiddenException("Organization membership required.");
    const [plan] = await this.db
      .select()
      .from(hrBenefitPlans)
      .where(and(eq(hrBenefitPlans.id, data.planId), eq(hrBenefitPlans.orgId, orgId)))
      .limit(1);

    if (!plan || plan.status !== "active") {
      throw new BadRequestException("Benefit plan is not available for enrollment");
    }

    const windowOpen = await this.plans.checkEnrollmentWindowOpen(orgId, data.planId);
    if (!windowOpen) {
      throw new BadRequestException("Enrollment window for this plan is not currently open");
    }

    try {
      const [enrollment] = await this.db
        .insert(hrBenefitEnrollments)
        .values({
          orgId,
          planId: data.planId,
          userId,
          userMembershipId: membershipId,
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

  async waive(orgId: string, userId: string, membershipId: number | null, data: WaiveInput) {
    if (membershipId == null) throw new ForbiddenException("Organization membership required.");
    const [existing] = await this.db
      .select()
      .from(hrBenefitEnrollments)
      .where(
        and(
          eq(hrBenefitEnrollments.orgId, orgId),
          eq(hrBenefitEnrollments.userMembershipId, membershipId),
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
      .values({ orgId, planId: data.planId, userId, userMembershipId: membershipId, status: "waived" })
      .returning();
    return enrollment;
  }

  async getMyBenefits(orgId: string, userId: string, membershipId: number | null) {
    if (membershipId == null) throw new ForbiddenException("Organization membership required.");
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
            eq(hrBenefitEnrollments.userMembershipId, membershipId),
          ),
        )
        .orderBy(desc(hrBenefitEnrollments.enrolledAt))
        .limit(50),
      this.db
        .select({
          id: hrDependents.id,
          orgId: hrDependents.orgId,
          userId: hrDependents.userId,
          name: hrDependents.name,
          relationship: hrDependents.relationship,
          dateOfBirth: hrDependents.dateOfBirth,
          isCovered: hrDependents.isCovered,
          createdAt: hrDependents.createdAt,
        })
        .from(hrDependents)
        .where(and(eq(hrDependents.orgId, orgId), eq(hrDependents.userMembershipId, membershipId)))
        .orderBy(hrDependents.name)
        .limit(200),
    ]);

    const enrollments = enrollmentRows.map((r) => ({ ...r.enrollment, plan: r.plan }));
    return { enrollments, dependents };
  }

  async listDependents(orgId: string, userId: string, membershipId: number | null) {
    if (membershipId == null) throw new ForbiddenException("Organization membership required.");
    return this.db
      .select({
        id: hrDependents.id,
        orgId: hrDependents.orgId,
        userId: hrDependents.userId,
        name: hrDependents.name,
        relationship: hrDependents.relationship,
        dateOfBirth: hrDependents.dateOfBirth,
        isCovered: hrDependents.isCovered,
        createdAt: hrDependents.createdAt,
      })
      .from(hrDependents)
      .where(and(eq(hrDependents.orgId, orgId), eq(hrDependents.userMembershipId, membershipId)))
      .orderBy(hrDependents.name)
      .limit(200);
  }

  async addDependent(orgId: string, userId: string, membershipId: number | null, data: CreateDependentInput) {
    if (membershipId == null) throw new ForbiddenException("Organization membership required.");
    const [dep] = await this.db
      .insert(hrDependents)
      .values({ ...data, orgId, userId, userMembershipId: membershipId })
      .returning();
    return dep;
  }

  async updateDependent(orgId: string, userId: string, membershipId: number | null, depId: number, data: PatchDependentInput) {
    if (membershipId == null) throw new ForbiddenException("Organization membership required.");
    const [existing] = await this.db
      .select({ id: hrDependents.id })
      .from(hrDependents)
      .where(
        and(
          eq(hrDependents.id, depId),
          eq(hrDependents.orgId, orgId),
          eq(hrDependents.userMembershipId, membershipId),
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundException("Dependent not found");

    const [updated] = await this.db
      .update(hrDependents)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(hrDependents.id, depId), eq(hrDependents.orgId, orgId), eq(hrDependents.userMembershipId, membershipId)))
      .returning();
    return updated;
  }

  async deleteDependent(orgId: string, userId: string, membershipId: number | null, depId: number) {
    if (membershipId == null) throw new ForbiddenException("Organization membership required.");
    const [existing] = await this.db
      .select({ id: hrDependents.id })
      .from(hrDependents)
      .where(
        and(
          eq(hrDependents.id, depId),
          eq(hrDependents.orgId, orgId),
          eq(hrDependents.userMembershipId, membershipId),
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundException("Dependent not found");

    await this.db
      .delete(hrDependents)
      .where(and(eq(hrDependents.id, depId), eq(hrDependents.orgId, orgId), eq(hrDependents.userMembershipId, membershipId)));
    return { ok: true };
  }
}
