import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { feedbackCycles, feedbackCycleRequests, feedbackCycleResponses } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";

@Injectable()
export class FeedbackService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listCycles(orgId: string) {
    return this.db
      .select()
      .from(feedbackCycles)
      .where(eq(feedbackCycles.orgId, orgId));
  }

  createCycle(
    orgId: string,
    createdBy: string,
    data: {
      name: string;
      type?: string;
      startDate: string;
      endDate: string;
      isAnonymous?: boolean;
      questions?: { id: string; text: string; type: "rating" | "text" }[];
    },
  ) {
    return this.db
      .insert(feedbackCycles)
      .values({ orgId, createdBy, ...data })
      .returning();
  }

  async getCycle(orgId: string, id: number) {
    const cycle = await this.db
      .select()
      .from(feedbackCycles)
      .where(and(eq(feedbackCycles.id, id), eq(feedbackCycles.orgId, orgId)))
      .limit(1);

    if (cycle.length === 0) throw new NotFoundException("Feedback cycle not found.");

    const requests = await this.db
      .select()
      .from(feedbackCycleRequests)
      .where(eq(feedbackCycleRequests.cycleId, id));

    return { ...cycle[0], requests };
  }

  async updateCycleStatus(orgId: string, id: number, status: string) {
    const existing = await this.db
      .select({ id: feedbackCycles.id })
      .from(feedbackCycles)
      .where(and(eq(feedbackCycles.id, id), eq(feedbackCycles.orgId, orgId)))
      .limit(1);

    if (existing.length === 0) throw new NotFoundException("Feedback cycle not found.");

    return this.db
      .update(feedbackCycles)
      .set({ status })
      .where(and(eq(feedbackCycles.id, id), eq(feedbackCycles.orgId, orgId)))
      .returning();
  }

  getMyPendingReviews(orgId: string, userId: string) {
    return this.db
      .select({
        id: feedbackCycleRequests.id,
        cycleId: feedbackCycleRequests.cycleId,
        subjectId: feedbackCycleRequests.subjectId,
        reviewerId: feedbackCycleRequests.reviewerId,
        relationship: feedbackCycleRequests.relationship,
        status: feedbackCycleRequests.status,
        createdAt: feedbackCycleRequests.createdAt,
      })
      .from(feedbackCycleRequests)
      .innerJoin(feedbackCycles, eq(feedbackCycleRequests.cycleId, feedbackCycles.id))
      .where(
        and(
          eq(feedbackCycles.orgId, orgId),
          eq(feedbackCycleRequests.reviewerId, userId),
          eq(feedbackCycleRequests.status, "PENDING"),
        ),
      );
  }

  async submitResponse(
    orgId: string,
    userId: string,
    requestId: number,
    data: {
      responses: { questionId: string; rating?: number; text?: string }[];
      overallRating?: number;
    },
  ) {
    const request = await this.db
      .select({ id: feedbackCycleRequests.id, cycleId: feedbackCycleRequests.cycleId })
      .from(feedbackCycleRequests)
      .innerJoin(feedbackCycles, eq(feedbackCycleRequests.cycleId, feedbackCycles.id))
      .where(
        and(
          eq(feedbackCycleRequests.id, requestId),
          eq(feedbackCycleRequests.reviewerId, userId),
          eq(feedbackCycles.orgId, orgId),
        ),
      )
      .limit(1);

    if (request.length === 0) throw new NotFoundException("Feedback request not found.");

    const cycleId = request[0].cycleId;

    await this.db.transaction(async (tx) => {
      await tx
        .insert(feedbackCycleResponses)
        .values({ requestId, responses: data.responses, overallRating: data.overallRating });

      await tx
        .update(feedbackCycleRequests)
        .set({ status: "COMPLETED", submittedAt: new Date() })
        .where(and(eq(feedbackCycleRequests.id, requestId), eq(feedbackCycleRequests.cycleId, cycleId)));
    });

    return { success: true };
  }

  async getResults(orgId: string, subjectId: string) {
    const requests = await this.db
      .select({ id: feedbackCycleRequests.id, relationship: feedbackCycleRequests.relationship, status: feedbackCycleRequests.status })
      .from(feedbackCycleRequests)
      .innerJoin(feedbackCycles, eq(feedbackCycleRequests.cycleId, feedbackCycles.id))
      .where(
        and(
          eq(feedbackCycleRequests.subjectId, subjectId),
          eq(feedbackCycles.orgId, orgId),
          eq(feedbackCycleRequests.status, "COMPLETED"),
        ),
      );

    if (requests.length === 0) return { subjectId, requests: [], responses: [] };

    const requestIds = requests.map((r) => r.id);
    const responses = await this.db
      .select()
      .from(feedbackCycleResponses)
      .where(inArray(feedbackCycleResponses.requestId, requestIds));

    return { subjectId, requests, responses };
  }
}
