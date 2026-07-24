import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { hrEmployments, hrPeople } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { HrPolicyEvaluationService } from "../hr-policies/hr-policy-evaluation.service";
import { HrEmploymentsService } from "../hr-core/hr-employments.service";
import { ProbationService } from "../hr-lifecycle/probation.service";

@Injectable()
export class OnboardingProbationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly policyEval: HrPolicyEvaluationService,
    private readonly employments: HrEmploymentsService,
    private readonly probationReviews: ProbationService,
  ) {}

  async setupProbationForUser(
    orgId: string,
    userId: string,
  ): Promise<{ probationEndDate: Date | null; lifecycleStatus: "PROBATION" | "ACTIVE" | null }> {
    const [employment] = await this.db
      .select({
        id: hrEmployments.id,
        personId: hrEmployments.personId,
        joiningDate: hrEmployments.joiningDate,
        lifecycleStatus: hrEmployments.lifecycleStatus,
      })
      .from(hrEmployments)
      .innerJoin(hrPeople, eq(hrEmployments.personId, hrPeople.id))
      .where(
        and(
          eq(hrEmployments.orgId, orgId),
          eq(hrPeople.userId, userId),
          eq(hrEmployments.isPrimary, true),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .limit(1);
    if (!employment) return { probationEndDate: null, lifecycleStatus: null };

    const joining = employment.joiningDate ? new Date(employment.joiningDate) : null;
    const result = await this.setupProbationFromPolicy(
      orgId,
      employment.id,
      employment.personId,
      userId,
      joining,
    );

    const today = new Date().toISOString().slice(0, 10);
    let currentStatus = employment.lifecycleStatus;

    if (currentStatus === "PRE_JOINING" || currentStatus === "CANDIDATE") {
      await this.employments.transition(orgId, employment.id, userId, {
        toStatus: "ONBOARDING",
        reason: "Onboarding completion path — intermediate status",
        effectiveDate: today,
      });
      currentStatus = "ONBOARDING";
    }

    if (result.probationEndDate) {
      if (currentStatus === "ONBOARDING") {
        await this.employments.transition(orgId, employment.id, userId, {
          toStatus: "PROBATION",
          reason: "Onboarding checklist completed — probation started",
          effectiveDate: today,
        });
      }
      await this.probationReviews.setupProbation(
        orgId,
        employment.id,
        employment.personId,
        result.probationEndDate,
      );
      return { probationEndDate: result.probationEndDate, lifecycleStatus: "PROBATION" };
    }

    if (currentStatus === "ONBOARDING") {
      await this.employments.transition(orgId, employment.id, userId, {
        toStatus: "ACTIVE",
        reason: "Onboarding checklist completed — no probation policy",
        effectiveDate: today,
      });
      return { probationEndDate: null, lifecycleStatus: "ACTIVE" };
    }

    return { probationEndDate: null, lifecycleStatus: null };
  }

  async setupProbationFromPolicy(
    orgId: string,
    employmentId: number,
    _personId: number,
    userId: string,
    joiningDate: Date | null,
  ): Promise<{ probationEndDate: Date | null }> {
    const eventDate = (joiningDate ?? new Date()).toISOString().slice(0, 10);

    const result = await this.policyEval.evaluatePolicy(orgId, userId, "probation", eventDate);

    if (!result) return { probationEndDate: null };

    const rules = result.rules as Record<string, unknown>;
    const durationDays = typeof rules["durationDays"] === "number" ? rules["durationDays"] : null;

    if (durationDays === null) return { probationEndDate: null };

    const base = joiningDate ?? new Date();
    const probationEndDate = new Date(base.getTime() + durationDays * 86_400_000);

    await this.db
      .update(hrEmployments)
      .set({ probationEndDate: probationEndDate.toISOString().slice(0, 10) })
      .where(and(eq(hrEmployments.id, employmentId), eq(hrEmployments.orgId, orgId)));

    return { probationEndDate };
  }
}
