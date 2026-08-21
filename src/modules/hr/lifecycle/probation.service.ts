import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrEmployments, hrPeople } from "../../../db/schema/hr/core-people";
import { hrProbationReviews } from "../../../db/schema/hr/probation";
import { HrAuditService } from "../core/hr-audit.service";
import { HrEmploymentsService } from "../core/hr-employments.service";
import { HrAutomationEngineService } from "../automations/hr-automation-engine.service";
import { HrPolicyEvaluationService } from "../policies/hr-policy-evaluation.service";
import { HrTemplateRenderService } from "../templates/hr-template-render.service";
import { HrWorkflowEngineService } from "../workflows/hr-workflow-engine.service";
import type {
  ConfirmProbationInput,
  ExtendProbationInput,
  ListProbationReviewsInput,
  StartReviewInput,
} from "./dto/probation.schemas";
import { ProbationReviewReaderService } from "./probation-review-reader.service";

function configuredMaxExtensions(rules: unknown): number {
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) return 1;
  if (!("maxExtensions" in rules)) return 1;
  const value = rules.maxExtensions;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 1;
}

@Injectable()
export class ProbationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly workflowEngine: HrWorkflowEngineService,
    private readonly templateRender: HrTemplateRenderService,
    private readonly automation: HrAutomationEngineService,
    private readonly policyEvaluation: HrPolicyEvaluationService,
    private readonly employments: HrEmploymentsService,
    private readonly audit: HrAuditService,
    private readonly reader: ProbationReviewReaderService,
  ) {}

  async listDueForReview(orgId: string, query: ListProbationReviewsInput) {
    return this.reader.listDueForReview(orgId, query);
  }

  async startReview(
    orgId: string,
    actorId: string,
    employmentId: number,
    input: StartReviewInput,
  ) {
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${orgId}:${employmentId}:probation`}, 0))`,
      );
      const [employment] = await tx
        .select({
          id: hrEmployments.id,
          personId: hrEmployments.personId,
          probationEndDate: hrEmployments.probationEndDate,
          userId: hrPeople.userId,
        })
        .from(hrEmployments)
        .innerJoin(
          hrPeople,
          and(eq(hrPeople.orgId, hrEmployments.orgId), eq(hrPeople.id, hrEmployments.personId)),
        )
        .where(
          and(
            eq(hrEmployments.orgId, orgId),
            eq(hrEmployments.id, employmentId),
            isNull(hrEmployments.deletedAt),
            isNull(hrPeople.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!employment) throw new NotFoundException("Employment not found.");

      const [existing] = await tx
        .select({ id: hrProbationReviews.id, status: hrProbationReviews.status })
        .from(hrProbationReviews)
        .where(
          and(
            eq(hrProbationReviews.orgId, orgId),
            eq(hrProbationReviews.employmentId, employmentId),
          ),
        )
        .limit(1)
        .for("update");
      if (existing) {
        if (existing.status === "confirmed" || existing.status === "terminated") {
          throw new ConflictException(`This probation review is already ${existing.status}.`);
        }
        if (input.reviewNotes || input.templateId) {
          await tx
            .update(hrProbationReviews)
            .set({
              reviewNotes: input.reviewNotes,
              reviewTemplateId: input.templateId,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(hrProbationReviews.id, existing.id),
                eq(hrProbationReviews.orgId, orgId),
                eq(hrProbationReviews.status, existing.status),
              ),
            );
        }
        return { reviewId: existing.id, userId: employment.userId ?? actorId, created: false };
      }

      const [inserted] = await tx
        .insert(hrProbationReviews)
        .values({
          orgId,
          employmentId,
          personId: employment.personId,
          probationEndDate: employment.probationEndDate ?? new Date().toISOString().slice(0, 10),
          reviewNotes: input.reviewNotes,
          reviewTemplateId: input.templateId,
        })
        .returning({ id: hrProbationReviews.id });
      if (!inserted) throw new ConflictException("Failed to start probation review.");
      const subjectUserId = employment.userId ?? actorId;
      await this.workflowEngine.startWorkflow({
        orgId,
        objectType: "probation_confirmation",
        objectId: String(inserted.id),
        requestedByUserId: actorId,
        subjectEmployeeId: subjectUserId,
        tx,
      });
      await this.audit.log(
        {
          orgId,
          actorId,
          entityType: "hr_probation_reviews",
          entityId: String(inserted.id),
          action: "started",
          after: { employmentId },
        },
        tx,
      );
      return { reviewId: inserted.id, userId: subjectUserId, created: true };
    });

    if (input.templateId) {
      await this.templateRender.buildContext(
        orgId,
        result.userId,
        employmentId,
        undefined,
        false,
      );
    }
    return { reviewId: result.reviewId, created: result.created };
  }

  async extend(
    orgId: string,
    actorId: string,
    probationReviewId: number,
    input: ExtendProbationInput,
  ) {
    return this.db.transaction(async (tx) => {
      const [review] = await tx
        .select({
          id: hrProbationReviews.id,
          personId: hrProbationReviews.personId,
          extensionCount: hrProbationReviews.extensionCount,
          employmentId: hrProbationReviews.employmentId,
          probationEndDate: hrProbationReviews.probationEndDate,
          extendedUntil: hrProbationReviews.extendedUntil,
          status: hrProbationReviews.status,
          userId: hrPeople.userId,
        })
        .from(hrProbationReviews)
        .innerJoin(
          hrPeople,
          and(eq(hrPeople.orgId, hrProbationReviews.orgId), eq(hrPeople.id, hrProbationReviews.personId)),
        )
        .where(
          and(
            eq(hrProbationReviews.orgId, orgId),
            eq(hrProbationReviews.id, probationReviewId),
          ),
        )
        .limit(1)
        .for("update");
      if (!review) throw new NotFoundException("Probation review not found.");
      if (review.status === "confirmed" || review.status === "terminated") {
        throw new ConflictException(`This probation review is already ${review.status}.`);
      }

      const currentEnd = review.extendedUntil ?? review.probationEndDate;
      if (input.extendedUntil <= currentEnd) {
        throw new BadRequestException("The extension date must be after the current probation end date.");
      }
      const today = new Date().toISOString().slice(0, 10);
      const policy = review.userId
        ? await this.policyEvaluation.evaluatePolicy(orgId, review.userId, "probation", today)
        : null;
      const maxExtensions = configuredMaxExtensions(policy?.rules);
      if (review.extensionCount >= maxExtensions) {
        throw new ConflictException(`Maximum extensions (${maxExtensions}) already reached.`);
      }

      const [updated] = await tx
        .update(hrProbationReviews)
        .set({
          status: "extended",
          extensionCount: review.extensionCount + 1,
          extendedUntil: input.extendedUntil,
          reviewNotes: sql`coalesce(${hrProbationReviews.reviewNotes}, '{}'::jsonb) || ${JSON.stringify({ extensionReason: input.reason })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(hrProbationReviews.orgId, orgId),
            eq(hrProbationReviews.id, probationReviewId),
            eq(hrProbationReviews.status, review.status),
            eq(hrProbationReviews.extensionCount, review.extensionCount),
          ),
        )
        .returning();
      if (!updated) throw new ConflictException("The probation review was updated by another request.");

      const [employment] = await tx
        .update(hrEmployments)
        .set({
          probationEndDate: input.extendedUntil,
          rowVersion: sql`${hrEmployments.rowVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(hrEmployments.id, review.employmentId),
            eq(hrEmployments.orgId, orgId),
            isNull(hrEmployments.deletedAt),
          ),
        )
        .returning({ id: hrEmployments.id });
      if (!employment) throw new ConflictException("The employment is no longer active.");
      await this.audit.log(
        {
          orgId,
          actorId,
          entityType: "hr_probation_reviews",
          entityId: String(probationReviewId),
          action: "extended",
          before: { endDate: currentEnd, extensionCount: review.extensionCount },
          after: { endDate: input.extendedUntil, reason: input.reason },
        },
        tx,
      );
      return updated;
    });
  }

  async confirm(
    orgId: string,
    actorId: string,
    probationReviewId: number,
    input: ConfirmProbationInput,
  ) {
    const result = await this.db.transaction(async (tx) => {
      const [review] = await tx
        .select({
          personId: hrProbationReviews.personId,
          employmentId: hrProbationReviews.employmentId,
          reviewNotes: hrProbationReviews.reviewNotes,
          status: hrProbationReviews.status,
          userId: hrPeople.userId,
        })
        .from(hrProbationReviews)
        .innerJoin(
          hrPeople,
          and(eq(hrPeople.orgId, hrProbationReviews.orgId), eq(hrPeople.id, hrProbationReviews.personId)),
        )
        .where(
          and(
            eq(hrProbationReviews.orgId, orgId),
            eq(hrProbationReviews.id, probationReviewId),
          ),
        )
        .limit(1)
        .for("update");
      if (!review) throw new NotFoundException("Probation review not found.");
      if (review.status === "confirmed" || review.status === "terminated") {
        throw new ConflictException(`This probation review is already ${review.status}.`);
      }

      const confirmedAt = input.confirmedAt
        ? new Date(`${input.confirmedAt}T00:00:00.000Z`)
        : new Date();
      const confirmedDate = confirmedAt.toISOString().slice(0, 10);
      const reviewNotes = input.notes
        ? { ...(review.reviewNotes ?? {}), confirmationNotes: input.notes }
        : review.reviewNotes;
      const [updated] = await tx
        .update(hrProbationReviews)
        .set({ status: "confirmed", confirmedAt, reviewNotes, updatedAt: new Date() })
        .where(
          and(
            eq(hrProbationReviews.orgId, orgId),
            eq(hrProbationReviews.id, probationReviewId),
            eq(hrProbationReviews.status, review.status),
          ),
        )
        .returning();
      if (!updated) throw new ConflictException("The probation review was updated by another request.");

      await this.employments.transition(
        orgId,
        review.employmentId,
        actorId,
        {
          toStatus: "CONFIRMED",
          reason: "Probation confirmed",
          notes: input.notes,
          effectiveDate: confirmedDate,
        },
        tx,
      );
      await this.audit.log(
        {
          orgId,
          actorId,
          entityType: "hr_probation_reviews",
          entityId: String(probationReviewId),
          action: "confirmed",
          before: { status: review.status },
          after: { status: "confirmed", confirmedDate },
        },
        tx,
      );
      return {
        updated,
        confirmedDate,
        employeeId: review.userId ?? String(review.personId),
        employmentId: review.employmentId,
      };
    });

    await this.automation.emit(orgId, "employee.confirmed", {
      employeeId: result.employeeId,
      employmentId: result.employmentId,
      confirmedAt: result.confirmedDate,
    });
    return result.updated;
  }

  async setupProbation(
    orgId: string,
    employmentId: number,
    personId: number,
    probationEndDate: Date,
  ) {
    const endDate = probationEndDate.toISOString().slice(0, 10);
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${orgId}:${employmentId}:probation`}, 0))`,
      );
      const [existing] = await tx
        .select({ id: hrProbationReviews.id })
        .from(hrProbationReviews)
        .where(
          and(
            eq(hrProbationReviews.orgId, orgId),
            eq(hrProbationReviews.employmentId, employmentId),
          ),
        )
        .limit(1);
      if (!existing) {
        await tx
          .insert(hrProbationReviews)
          .values({ orgId, employmentId, personId, probationEndDate: endDate });
      }
    });
    return { orgId, employmentId, personId, probationEndDate: endDate };
  }

  async sweepDue(orgId: string) {
    const due = await this.reader.listDueForSweep(orgId);

    if (due.length === 0) return { updated: 0, hasMore: false };
    const userIds = await this.reader.resolveUserIds(
      orgId,
      due.map((review) => review.personId),
    );
    await Promise.all(
      due.map((review) =>
        this.automation.emit(orgId, "employee.probation_due", {
          employeeId: userIds.get(review.personId) ?? String(review.personId),
          daysUntilEnd: 0,
        }),
      ),
    );
    return { updated: due.length, hasMore: due.length === 100 };
  }
}
