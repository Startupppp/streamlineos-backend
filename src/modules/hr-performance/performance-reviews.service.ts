import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import {
  organizationMembers,
  performanceReviews,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { EmailService } from "../email/email.service";
import { ReviewCyclesService } from "./review-cycles.service";
import { OneOnOneMeetingsService } from "./one-on-one-meetings.service";
import { PerformancePipsService } from "./performance-pips.service";
import type {
  CreateOneOnOneInput,
  CreatePerformanceReviewInput,
  CreatePipInput,
  CreateReviewCycleInput,
  UpdateOneOnOneInput,
  UpdatePerformanceReviewInput,
  UpdatePipInput,
  UpdateReviewCycleInput,
} from "./dto/performance.schemas";

@Injectable()
export class PerformanceReviewsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
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
    const [review] = await this.db
      .insert(performanceReviews)
      .values({
        orgId,
        userId: input.userId,
        reviewerId,
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

    void this.notifyReviewAssigned(
      input.userId,
      reviewerId,
      input.periodStart,
      input.periodEnd,
    );

    return review;
  }

  listReviews(
    orgId: string,
    userId: string,
    scope: DataScope,
    filters: {
      userId?: string;
      cycleId?: number;
      limit?: number;
      offset?: number;
    },
  ) {
    const conditions = [eq(performanceReviews.orgId, orgId)];
    conditions.push(
      applyScope(scope, userId, { ownerColumn: performanceReviews.userId }),
    );
    if (filters.userId && scope === "all") {
      conditions.push(eq(performanceReviews.userId, filters.userId));
    }
    if (filters.cycleId)
      conditions.push(eq(performanceReviews.cycleId, filters.cycleId));

    const limit = Math.min(filters.limit ?? 50, 100);
    const offset = Math.max(filters.offset ?? 0, 0);

    return this.db.query.performanceReviews.findMany({
      where: and(...conditions),
      with: {
        user: { columns: { id: true, name: true, image: true } },
        reviewer: { columns: { id: true, name: true } },
        cycle: true,
      },
      orderBy: [desc(performanceReviews.createdAt)],
      limit,
      offset,
    });
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
    employeeId: string,
    reviewerId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<void> {
    try {
      const [employee, reviewer] = await Promise.all([
        this.db.query.users.findFirst({
          where: eq(users.id, employeeId),
          columns: { email: true, name: true },
        }),
        this.db.query.users.findFirst({
          where: eq(users.id, reviewerId),
          columns: { name: true },
        }),
      ]);
      if (employee?.email) {
        await this.email.sendReviewAssignedEmail(
          employee.email,
          employee.name ?? "Employee",
          reviewer?.name ?? "Manager",
          periodStart,
          periodEnd,
        );
      }
    } catch (error) {
      logger.error("Failed to send review assigned email", {
        employeeId,
        error,
      });
    }
  }
}
