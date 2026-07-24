import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, lte, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { hrEmployments, hrPeople } from "../../db/schema/hr/core-people";
import { hrProbationReviews } from "../../db/schema/hr/probation";
import { HrWorkflowEngineService } from "../hr-workflows/hr-workflow-engine.service";
import { HrTemplateRenderService } from "../hr-templates/hr-template-render.service";
import { HrAutomationEngineService } from "../hr-automations/hr-automation-engine.service";
import { HrPolicyEvaluationService } from "../hr-policies/hr-policy-evaluation.service";
import { HrEmploymentsService } from "../hr-core/hr-employments.service";
import type { StartReviewInput, ExtendProbationInput, ConfirmProbationInput } from "./dto/probation.schemas";

@Injectable()
export class ProbationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly workflowEngine: HrWorkflowEngineService,
    private readonly templateRender: HrTemplateRenderService,
    private readonly automation: HrAutomationEngineService,
    private readonly policyEvaluation: HrPolicyEvaluationService,
    private readonly employments: HrEmploymentsService,
  ) {}

  async listDueForReview(orgId: string) {
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
    const cutoff = sevenDaysFromNow.toISOString().slice(0, 10);

    return this.db
      .select({
        id: hrProbationReviews.id,
        orgId: hrProbationReviews.orgId,
        employmentId: hrProbationReviews.employmentId,
        personId: hrProbationReviews.personId,
        probationEndDate: hrProbationReviews.probationEndDate,
        status: hrProbationReviews.status,
        extensionCount: hrProbationReviews.extensionCount,
        extendedUntil: hrProbationReviews.extendedUntil,
        confirmedAt: hrProbationReviews.confirmedAt,
        createdAt: hrProbationReviews.createdAt,
        firstName: hrPeople.firstName,
        lastName: hrPeople.lastName,
        workEmail: hrPeople.workEmail,
      })
      .from(hrProbationReviews)
      .innerJoin(hrPeople, eq(hrProbationReviews.personId, hrPeople.id))
      .where(
        and(
          eq(hrProbationReviews.orgId, orgId),
          or(
            eq(hrProbationReviews.status, "review_due"),
            and(
              eq(hrProbationReviews.status, "in_probation"),
              lte(hrProbationReviews.probationEndDate, cutoff),
            ),
          ),
        ),
      );
  }

  async startReview(
    orgId: string,
    actorId: string,
    employmentId: number,
    input: StartReviewInput,
  ) {
    const [employment] = await this.db
      .select({
        id: hrEmployments.id,
        personId: hrEmployments.personId,
        probationEndDate: hrEmployments.probationEndDate,
      })
      .from(hrEmployments)
      .where(and(eq(hrEmployments.orgId, orgId), eq(hrEmployments.id, employmentId)));

    if (!employment) {
      throw new NotFoundException("Employment not found");
    }

    const [person] = await this.db
      .select({ id: hrPeople.id, userId: hrPeople.userId })
      .from(hrPeople)
      .where(and(eq(hrPeople.orgId, orgId), eq(hrPeople.id, employment.personId)));

    if (!person) {
      throw new NotFoundException("Person not found");
    }

    const endDate = employment.probationEndDate ?? new Date().toISOString().slice(0, 10);

    const [existing] = await this.db
      .select({ id: hrProbationReviews.id })
      .from(hrProbationReviews)
      .where(
        and(
          eq(hrProbationReviews.orgId, orgId),
          eq(hrProbationReviews.employmentId, employmentId),
        ),
      );

    let reviewId: number;
    if (existing) {
      reviewId = existing.id;
      if (input.reviewNotes) {
        await this.db
          .update(hrProbationReviews)
          .set({ reviewNotes: input.reviewNotes, reviewTemplateId: input.templateId ?? null, updatedAt: new Date() })
          .where(eq(hrProbationReviews.id, existing.id));
      }
    } else {
      const [inserted] = await this.db
        .insert(hrProbationReviews)
        .values({
          orgId,
          employmentId,
          personId: employment.personId,
          probationEndDate: endDate,
          reviewNotes: input.reviewNotes,
          reviewTemplateId: input.templateId ?? null,
        })
        .returning({ id: hrProbationReviews.id });
      reviewId = inserted.id;
    }

    const subjectUserId = person.userId ?? actorId;

    await this.workflowEngine.startWorkflow({
      orgId,
      objectType: "probation_confirmation",
      objectId: String(reviewId),
      requestedByUserId: actorId,
      subjectEmployeeId: subjectUserId,
    });

    if (input.templateId) {
      await this.templateRender.buildContext(orgId, subjectUserId, employmentId, undefined, false);
    }

    return { reviewId };
  }

  async extend(
    orgId: string,
    _actorId: string,
    reviewId: number,
    input: ExtendProbationInput,
  ) {
    const [review] = await this.db
      .select({
        id: hrProbationReviews.id,
        personId: hrProbationReviews.personId,
        extensionCount: hrProbationReviews.extensionCount,
        employmentId: hrProbationReviews.employmentId,
      })
      .from(hrProbationReviews)
      .where(and(eq(hrProbationReviews.orgId, orgId), eq(hrProbationReviews.id, reviewId)));

    if (!review) {
      throw new NotFoundException("Probation review not found");
    }

    const [person] = await this.db
      .select({ userId: hrPeople.userId })
      .from(hrPeople)
      .where(and(eq(hrPeople.orgId, orgId), eq(hrPeople.id, review.personId)));

    const userId = person?.userId;
    const today = new Date().toISOString().slice(0, 10);

    if (userId) {
      const policy = await this.policyEvaluation.evaluatePolicy(orgId, userId, "probation", today);
      if (policy) {
        const rules = policy.rules as { maxExtensions?: number };
        const maxExtensions = rules.maxExtensions ?? 1;
        if (review.extensionCount >= maxExtensions) {
          throw new BadRequestException(
            `Maximum extensions (${maxExtensions}) already reached for this probation review`,
          );
        }
      }
    }

    const [updated] = await this.db
      .update(hrProbationReviews)
      .set({
        status: "extended",
        extensionCount: review.extensionCount + 1,
        extendedUntil: input.extendedUntil,
        updatedAt: new Date(),
      })
      .where(and(eq(hrProbationReviews.orgId, orgId), eq(hrProbationReviews.id, reviewId)))
      .returning();

    return updated;
  }

  async confirm(
    orgId: string,
    actorId: string,
    reviewId: number,
    input: ConfirmProbationInput,
  ) {
    const [review] = await this.db
      .select({
        id: hrProbationReviews.id,
        personId: hrProbationReviews.personId,
        employmentId: hrProbationReviews.employmentId,
        reviewNotes: hrProbationReviews.reviewNotes,
        status: hrProbationReviews.status,
      })
      .from(hrProbationReviews)
      .where(and(eq(hrProbationReviews.orgId, orgId), eq(hrProbationReviews.id, reviewId)));

    if (!review) {
      throw new NotFoundException("Probation review not found");
    }

    if (review.status === "confirmed") {
      throw new BadRequestException("This probation review has already been confirmed.");
    }

    const confirmedAt = input.confirmedAt ? new Date(input.confirmedAt) : new Date();
    const confirmedDate = confirmedAt.toISOString().slice(0, 10);
    const mergedNotes = input.notes
      ? { ...(review.reviewNotes ?? {}), confirmationNotes: input.notes }
      : review.reviewNotes;

    const [updated] = await this.db
      .update(hrProbationReviews)
      .set({ status: "confirmed", confirmedAt, reviewNotes: mergedNotes, updatedAt: new Date() })
      .where(and(eq(hrProbationReviews.orgId, orgId), eq(hrProbationReviews.id, reviewId)))
      .returning();

    await this.employments.transition(orgId, review.employmentId, actorId, {
      toStatus: "CONFIRMED",
      reason: "Probation confirmed",
      notes: input.notes,
      effectiveDate: confirmedDate,
    });

    const [person] = await this.db
      .select({ userId: hrPeople.userId })
      .from(hrPeople)
      .where(and(eq(hrPeople.orgId, orgId), eq(hrPeople.id, review.personId)));

    await this.automation.emit(orgId, "employee.confirmed", {
      employeeId: person?.userId ?? String(review.personId),
      employmentId: review.employmentId,
      confirmedAt: confirmedDate,
    });

    return updated;
  }

  async setupProbation(
    orgId: string,
    employmentId: number,
    personId: number,
    probationEndDate: Date,
  ) {
    const endDate = probationEndDate.toISOString().slice(0, 10);

    const [existing] = await this.db
      .select({ id: hrProbationReviews.id })
      .from(hrProbationReviews)
      .where(
        and(
          eq(hrProbationReviews.orgId, orgId),
          eq(hrProbationReviews.employmentId, employmentId),
        ),
      );

    if (!existing) {
      await this.db
        .insert(hrProbationReviews)
        .values({ orgId, employmentId, personId, probationEndDate: endDate });
    }

    return { orgId, employmentId, personId, probationEndDate: endDate };
  }

  async sweepDue(orgId: string) {
    const today = new Date().toISOString().slice(0, 10);

    const due = await this.db
      .select({
        id: hrProbationReviews.id,
        personId: hrProbationReviews.personId,
      })
      .from(hrProbationReviews)
      .where(
        and(
          eq(hrProbationReviews.orgId, orgId),
          eq(hrProbationReviews.status, "in_probation"),
          lte(hrProbationReviews.probationEndDate, today),
        ),
      );

    if (due.length === 0) return { updated: 0 };

    const ids = due.map((r) => r.id);

    await this.db
      .update(hrProbationReviews)
      .set({ status: "review_due", updatedAt: new Date() })
      .where(
        and(
          eq(hrProbationReviews.orgId, orgId),
          inArray(hrProbationReviews.id, ids),
        ),
      );

    const personIds = [...new Set(due.map((r) => r.personId))];
    const people = await this.db
      .select({ id: hrPeople.id, userId: hrPeople.userId })
      .from(hrPeople)
      .where(and(eq(hrPeople.orgId, orgId), inArray(hrPeople.id, personIds)));

    const userIdMap = new Map(people.map((p) => [p.id, p.userId]));

    for (const row of due) {
      await this.automation.emit(orgId, "employee.probation_due", {
        employeeId: userIdMap.get(row.personId) ?? String(row.personId),
        daysUntilEnd: 0,
      });
    }

    return { updated: ids.length };
  }
}
