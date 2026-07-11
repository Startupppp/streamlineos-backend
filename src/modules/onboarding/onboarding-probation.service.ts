import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { hrEmployments } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { HrPolicyEvaluationService } from "../hr-policies/hr-policy-evaluation.service";

@Injectable()
export class OnboardingProbationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly policyEval: HrPolicyEvaluationService,
  ) {}

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
