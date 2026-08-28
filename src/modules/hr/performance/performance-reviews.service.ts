import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import {
  organizationMembers,
  performanceReviews,
  reviewCycles,
  users,
} from "../../../db/schema";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import {
  keysetAfterId,
  keysetAfterValue,
  keysetBeforeId,
  keysetBeforeValue,
} from "../../../common/pagination/keyset";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../common/organization/organization-actor";
import { ReviewCyclesService } from "./review-cycles.service";
import { OneOnOneMeetingsService } from "./one-on-one-meetings.service";
import { PerformancePipsService } from "./performance-pips.service";
import type {
  CreateOneOnOneInput,
  CreatePerformanceReviewInput,
  CreatePipInput,
  CreateReviewCycleInput,
  ListPerformanceReviewsInput,
  UpdateOneOnOneInput,
  UpdatePerformanceReviewInput,
  UpdatePipInput,
  UpdateReviewCycleInput,
} from "./dto/performance.schemas";

@Injectable()
export class PerformanceReviewsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
    private readonly reviewCycles: ReviewCyclesService,
    private readonly oneOnOnes: OneOnOneMeetingsService,
    private readonly pips: PerformancePipsService,
  ) {}

  async createReview(
    orgId: string,
    actorId: string,
    input: CreatePerformanceReviewInput,
  ) {
    const targetMember = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, input.userId),
        eq(organizationMembers.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!targetMember)
      throw new NotFoundException("Employee not found in your organization.");

    if (input.cycleId) {
      const duplicate = await this.db.query.performanceReviews.findFirst({
        where: and(
          eq(performanceReviews.orgId, orgId),
          eq(performanceReviews.userId, input.userId),
          eq(performanceReviews.cycleId, input.cycleId),
        ),
        columns: { id: true },
      });
      if (duplicate) {
        throw new ConflictException(
          "A review for this employee already exists in the selected cycle.",
        );
      }
    } else {
      const adHocDuplicate = await this.db.query.performanceReviews.findFirst({
        where: and(
          eq(performanceReviews.orgId, orgId),
          eq(performanceReviews.userId, input.userId),
          eq(performanceReviews.periodStart, input.periodStart),
          eq(performanceReviews.periodEnd, input.periodEnd),
        ),
        columns: { id: true },
      });
      if (adHocDuplicate) {
        throw new ConflictException(
          "A review for this employee with the same period already exists.",
        );
      }
    }

    const reviewerId = input.reviewerId ?? actorId;

    let reviewerMembershipId: number;
    try {
      const actor = await assertOrganizationActor(this.db, orgId, {
        kind: "user",
        userId: reviewerId,
      });
      reviewerMembershipId = actor.membershipId;
    } catch (e) {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    }

    const [review] = await this.db
      .insert(performanceReviews)
      .values({
        orgId,
        userId: input.userId,
        reviewerId,
        reviewerMembershipId,
        cycleId: input.cycleId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        ratings: input.ratings,
        strengths: input.strengths,
        improvements: input.improvements,
        overallRating: input.overallRating?.toString(),
        comments: input.comments,
        status: "DRAFT",
      })
      .returning();

    await this.notifyReviewAssigned(
      orgId,
      review?.id,
      input.userId,
      reviewerId,
      input.periodStart,
      input.periodEnd,
    );

    return review;
  }

  async listReviews(
    orgId: string,
    actorUserId: string,
    scope: DataScope,
    query: ListPerformanceReviewsInput,
  ) {
    const conditions: SQL[] = [
      eq(performanceReviews.orgId, orgId),
      applyScope(scope, orgId, actorUserId, { ownerColumn: performanceReviews.userId }),
    ];
    if (query.userId) conditions.push(eq(performanceReviews.userId, query.userId));
    if (query.cycleId) conditions.push(eq(performanceReviews.cycleId, query.cycleId));
    if (query.status) conditions.push(eq(performanceReviews.status, query.status));

    const ascending = query.sortDir === "asc";
    const byPeriod = query.sortField === "periodStart";
    const sortColumn = byPeriod
      ? performanceReviews.periodStart
      : performanceReviews.createdAt;

    const position = decodeCursor(query.cursor);
    if (position) {
      const bound = byPeriod
        ? (ascending ? keysetAfterValue : keysetBeforeValue)(
            sortColumn,
            performanceReviews.id,
            position,
          )
        : (ascending ? keysetAfterId : keysetBeforeId)(
            sortColumn,
            performanceReviews.id,
            position,
          );
      conditions.push(bound);
    }

    const reviewer = alias(users, "performance_reviewer");
    const rows = await this.db
      .select({
        id: performanceReviews.id,
        orgId: performanceReviews.orgId,
        userId: performanceReviews.userId,
        reviewerId: performanceReviews.reviewerId,
        cycleId: performanceReviews.cycleId,
        periodStart: performanceReviews.periodStart,
        periodEnd: performanceReviews.periodEnd,
        status: performanceReviews.status,
        overallRating: performanceReviews.overallRating,
        createdAt: performanceReviews.createdAt,
        updatedAt: performanceReviews.updatedAt,
        user: { id: users.id, name: users.name, image: users.image },
        reviewer: { id: reviewer.id, name: reviewer.name },
        cycle: { id: reviewCycles.id, name: reviewCycles.name, status: reviewCycles.status },
      })
      .from(performanceReviews)
      .leftJoin(users, eq(users.id, performanceReviews.userId))
      .leftJoin(reviewer, eq(reviewer.id, performanceReviews.reviewerId))
      .leftJoin(
        reviewCycles,
        and(
          eq(reviewCycles.id, performanceReviews.cycleId),
          eq(reviewCycles.orgId, performanceReviews.orgId),
        ),
      )
      .where(and(...conditions))
      .orderBy(
        ascending ? asc(sortColumn) : desc(sortColumn),
        ascending ? asc(performanceReviews.id) : desc(performanceReviews.id),
      )
      .limit(query.limit + 1);

    return buildCursorPage(rows, query.limit, (row) => ({
      sortValue: byPeriod ? row.periodStart : row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }

  async getReview(orgId: string, reviewId: number) {
    const review = await this.db.query.performanceReviews.findFirst({
      where: and(
        eq(performanceReviews.id, reviewId),
        eq(performanceReviews.orgId, orgId),
      ),
      with: {
        user: { columns: { id: true, name: true, image: true } },
        reviewer: { columns: { id: true, name: true } },
        cycle: true,
      },
    });
    if (!review) throw new NotFoundException("Review not found.");
    return review;
  }

  async deleteReview(orgId: string, reviewId: number) {
    const existing = await this.db.query.performanceReviews.findFirst({
      where: and(
        eq(performanceReviews.id, reviewId),
        eq(performanceReviews.orgId, orgId),
      ),
      columns: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException("Review not found.");
    if (existing.status === "COMPLETED") {
      throw new ConflictException("Completed reviews cannot be deleted.");
    }

    await this.db
      .delete(performanceReviews)
      .where(
        and(
          eq(performanceReviews.id, reviewId),
          eq(performanceReviews.orgId, orgId),
        ),
      );
    return { success: true };
  }

  async updateReview(
    orgId: string,
    actorId: string,
    canManage: boolean,
    reviewId: number,
    input: UpdatePerformanceReviewInput,
  ) {
    const existing = await this.db.query.performanceReviews.findFirst({
      where: and(
        eq(performanceReviews.id, reviewId),
        eq(performanceReviews.orgId, orgId),
      ),
    });
    if (!existing) throw new NotFoundException("Review not found.");
    if (
      !canManage &&
      existing.reviewerId !== actorId &&
      existing.userId !== actorId
    ) {
      throw new ForbiddenException(
        "You can only edit reviews you are a participant in.",
      );
    }

    if (existing.status === "COMPLETED") {
      if (
        input.periodStart !== undefined ||
        input.periodEnd !== undefined ||
        input.cycleId !== undefined
      ) {
        throw new ConflictException(
          "Cannot edit period or cycle for a completed review.",
        );
      }
      if (
        input.ratings !== undefined ||
        input.strengths !== undefined ||
        input.improvements !== undefined ||
        input.overallRating !== undefined ||
        input.comments !== undefined
      ) {
        throw new ConflictException(
          "Cannot edit ratings, strengths, improvements, or comments on a completed review.",
        );
      }
      if (input.status !== undefined && input.status !== "ARCHIVED") {
        throw new ConflictException(
          "A completed review can only transition to ARCHIVED.",
        );
      }
    }

    await this.db
      .update(performanceReviews)
      .set({
        ...(input.ratings !== undefined && { ratings: input.ratings }),
        ...(input.strengths !== undefined && { strengths: input.strengths }),
        ...(input.improvements !== undefined && {
          improvements: input.improvements,
        }),
        ...(input.overallRating !== undefined && {
          overallRating: input.overallRating.toString(),
        }),
        ...(input.comments !== undefined && { comments: input.comments }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.periodStart !== undefined && {
          periodStart: input.periodStart,
        }),
        ...(input.periodEnd !== undefined && { periodEnd: input.periodEnd }),
        ...(input.cycleId !== undefined && { cycleId: input.cycleId }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(performanceReviews.id, reviewId),
          eq(performanceReviews.orgId, orgId),
        ),
      );

    return { success: true };
  }

  createCycle(orgId: string, actorId: string, input: CreateReviewCycleInput) {
    return this.reviewCycles.createCycle(orgId, actorId, input);
  }

  listCycles(orgId: string) {
    return this.reviewCycles.listCycles(orgId);
  }

  getCycle(orgId: string, cycleId: number) {
    return this.reviewCycles.getCycle(orgId, cycleId);
  }

  updateCycle(orgId: string, cycleId: number, input: UpdateReviewCycleInput) {
    return this.reviewCycles.updateCycle(orgId, cycleId, input);
  }

  deleteCycle(orgId: string, cycleId: number) {
    return this.reviewCycles.deleteCycle(orgId, cycleId);
  }

  listOneOnOnes(orgId: string, userId: string, upcoming: boolean) {
    return this.oneOnOnes.listOneOnOnes(orgId, userId, upcoming);
  }

  createOneOnOne(orgId: string, managerId: string, input: CreateOneOnOneInput) {
    return this.oneOnOnes.createOneOnOne(orgId, managerId, input);
  }

  updateOneOnOne(
    orgId: string,
    actorId: string,
    canManage: boolean,
    meetingId: number,
    input: UpdateOneOnOneInput,
  ) {
    return this.oneOnOnes.updateOneOnOne(
      orgId,
      actorId,
      canManage,
      meetingId,
      input,
    );
  }

  deleteOneOnOne(
    orgId: string,
    actorId: string,
    canManage: boolean,
    meetingId: number,
  ) {
    return this.oneOnOnes.deleteOneOnOne(orgId, actorId, canManage, meetingId);
  }

  listPips(orgId: string, userId: string, scope: DataScope) {
    return this.pips.listPips(orgId, userId, scope);
  }

  createPip(orgId: string, managerId: string, input: CreatePipInput) {
    return this.pips.createPip(orgId, managerId, input);
  }

  updatePip(orgId: string, pipId: number, input: UpdatePipInput) {
    return this.pips.updatePip(orgId, pipId, input);
  }

  private async notifyReviewAssigned(
    orgId: string,
    reviewId: number | undefined,
    employeeId: string,
    reviewerId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<void> {
    try {
      const [employee, reviewer] = await Promise.all([
        this.db.query.users.findFirst({
          where: eq(users.id, employeeId),
          columns: { id: true, name: true },
        }),
        this.db.query.users.findFirst({
          where: eq(users.id, reviewerId),
          columns: { name: true },
        }),
      ]);
      if (employee) await this.dispatch.emit({
        eventKey: "hr.performance.review_assigned",
        orgId,
        actorUserId: reviewerId,
        targetUserIds: [employee.id],
        entityType: "performance_review",
        entityId: reviewId ? String(reviewId) : undefined,
        message: "A performance review has been assigned to you.",
        variables: { employeeName: employee.name ?? "Employee", reviewerName: reviewer?.name ?? "Manager", periodStart, periodEnd },
      });
    } catch (error) {
      logger.error("Failed to send review assigned email", {
        employeeId,
        error,
      });
    }
  }
}
