import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { feedbackCycles, feedbackCycleRequests, feedbackCycleResponses } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { organizationMembers } from "../../../db/schema";

/**
 * One submitted 360° response, exactly as `FeedbackResult.responses[]` is
 * declared in `frontend/hooks/api/hr/feedback.ts`. Named so the two sides can be
 * compared by eye — nothing typechecks across the repo boundary.
 */
export interface FeedbackResponsePayload {
  requestId: number;
  overallRating?: number;
  submittedAt: string;
  responses: { questionId: string; rating?: number; text?: string }[];
}

@Injectable()
export class FeedbackService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listCycles(orgId: string) {
    return this.db
      .select()
      .from(feedbackCycles)
      .where(eq(feedbackCycles.orgId, orgId))
      .orderBy(feedbackCycles.createdAt)
      .limit(100);
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
      .where(eq(feedbackCycleRequests.cycleId, id))
      .limit(100);

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
      )
      .limit(100);
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
        .values({ requestId, orgId, responses: data.responses, overallRating: data.overallRating });

      await tx
        .update(feedbackCycleRequests)
        .set({ status: "COMPLETED", submittedAt: new Date() })
        .where(and(eq(feedbackCycleRequests.id, requestId), eq(feedbackCycleRequests.cycleId, cycleId)));
    });

    return { success: true };
  }

  async getResults(orgId: string, subjectId: string) {
    const subject = await this.db.query.organizationMembers.findFirst({
      columns: { id: true },
      where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, subjectId)),
    });
    if (!subject) throw new NotFoundException("Feedback subject not found in this organization");

    /*
     * The three headline numbers the 360° results panel renders, computed in one
     * aggregate so none of them saturates at the row cap below.
     *
     * `total` must count EVERY request for the subject, not only the completed
     * ones: the panel shows a completion rate, and a set already filtered to
     * COMPLETED can only ever report 100%. The left join duplicates a request
     * once per response, which is why the two counts are DISTINCT over the
     * request id; `avg` is over response rows and each response joins exactly
     * once, so it is the plain mean of the submitted overall ratings.
     *
     * count()/avg() come back from the driver as strings (bigint and numeric),
     * so both are coerced here rather than trusted from the SQL generic.
     */
    const [totals] = await this.db
      .select({
        total: sql<string>`count(distinct ${feedbackCycleRequests.id})`,
        completed: sql<string>`count(distinct ${feedbackCycleRequests.id}) filter (where ${feedbackCycleRequests.status} = 'COMPLETED')`,
        avgRating: sql<string | null>`avg(${feedbackCycleResponses.overallRating})`,
      })
      .from(feedbackCycleRequests)
      .innerJoin(feedbackCycles, eq(feedbackCycleRequests.cycleId, feedbackCycles.id))
      .leftJoin(
        feedbackCycleResponses,
        and(
          eq(feedbackCycleResponses.orgId, orgId),
          eq(feedbackCycleResponses.requestId, feedbackCycleRequests.id),
        ),
      )
      .where(
        and(eq(feedbackCycleRequests.subjectId, subjectId), eq(feedbackCycles.orgId, orgId)),
      );

    const totalRequests = Number(totals?.total ?? 0);
    const completedRequests = Number(totals?.completed ?? 0);
    const rawAvg = totals?.avgRating ?? null;
    const avgRating =
      rawAvg === null ? undefined : Math.round(Number(rawAvg) * 100) / 100;

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
      )
      .limit(100);

    const requestIds = requests.map((r) => r.id);
    const responseRows =
      requestIds.length === 0
        ? []
        : await this.db
            .select({
              requestId: feedbackCycleResponses.requestId,
              overallRating: feedbackCycleResponses.overallRating,
              submittedAt: feedbackCycleResponses.submittedAt,
              responses: feedbackCycleResponses.responses,
            })
            .from(feedbackCycleResponses)
            .where(
              and(
                eq(feedbackCycleResponses.orgId, orgId),
                inArray(feedbackCycleResponses.requestId, requestIds),
              ),
            )
            .limit(100);

    // Flattened to the shape the client declares: `overallRating` absent rather
    // than null, `submittedAt` an ISO string rather than a Date. One return, so
    // the endpoint's type is one object rather than a union a caller has to
    // narrow before it can read `responses`.
    const responses: FeedbackResponsePayload[] = responseRows.map((row) => ({
      requestId: row.requestId,
      overallRating: row.overallRating ?? undefined,
      submittedAt: row.submittedAt.toISOString(),
      responses: row.responses,
    }));

    return { subjectId, totalRequests, completedRequests, avgRating, requests, responses };
  }
}
