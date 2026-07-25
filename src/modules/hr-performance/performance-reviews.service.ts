import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, or } from "drizzle-orm";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import {
  oneOnOneMeetings,
  organizationMembers,
  performanceImprovementPlans,
  performanceReviews,
  reviewCycles,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { EmailService } from "../email/email.service";
import { AutomationService } from "../automation/automation.service";
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
    private readonly automation: AutomationService,
  ) {}

  async createReview(orgId: string, actorId: string, input: CreatePerformanceReviewInput) {
    const targetMember = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, input.userId),
        eq(organizationMembers.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!targetMember) throw new NotFoundException("Employee not found in your organization.");

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
        throw new ConflictException("A review for this employee already exists in the selected cycle.");
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
        throw new ConflictException("A review for this employee with the same period already exists.");
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

    void this.notifyReviewAssigned(input.userId, reviewerId, input.periodStart, input.periodEnd);

    return review;
  }

  async createCycle(orgId: string, actorId: string, input: CreateReviewCycleInput) {
    const existing = await this.db.query.reviewCycles.findFirst({
      where: and(eq(reviewCycles.orgId, orgId), eq(reviewCycles.name, input.name)),
      columns: { id: true },
    });
    if (existing) {
      throw new ConflictException(`A review cycle named "${input.name}" already exists.`);
    }

    const [cycle] = await this.db
      .insert(reviewCycles)
      .values({
        orgId,
        name: input.name,
        type: input.type,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        deadline: input.deadline,
        description: input.description,
        status: "DRAFT",
        createdBy: actorId,
      })
      .returning();

    void this.automation.runAutomationsForEvent(orgId, "performance.review_cycle_started", {
      cycleId: cycle.id,
      cycleName: cycle.name,
      startDate: cycle.periodStart,
      endDate: cycle.periodEnd,
      reviewerCount: 0,
    });

    return cycle;
  }

  private async notifyReviewAssigned(
    employeeId: string,
    reviewerId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<void> {
    try {
      const [employee, reviewer] = await Promise.all([
        this.db.query.users.findFirst({ where: eq(users.id, employeeId), columns: { email: true, name: true } }),
        this.db.query.users.findFirst({ where: eq(users.id, reviewerId), columns: { name: true } }),
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
      logger.error("Failed to send review assigned email", { employeeId, error });
    }
  }

  async listOneOnOnes(orgId: string, userId: string, upcoming: boolean) {
    const conditions = [
      eq(oneOnOneMeetings.orgId, orgId),
      or(
        eq(oneOnOneMeetings.managerId, userId),
        eq(oneOnOneMeetings.employeeId, userId),
      ),
    ];
    if (upcoming) {
      conditions.push(gte(oneOnOneMeetings.scheduledAt, new Date()));
    }

    const data = await this.db.query.oneOnOneMeetings.findMany({
      where: and(...conditions),
      with: {
        manager: { columns: { id: true, name: true, image: true } },
        employee: { columns: { id: true, name: true, image: true } },
      },
      orderBy: [desc(oneOnOneMeetings.scheduledAt)],
      limit: 100,
    });

    return data.map((m) => ({
      ...m,
      scheduledAt:
        m.scheduledAt instanceof Date ? m.scheduledAt.toISOString() : m.scheduledAt,
    }));
  }

  async createOneOnOne(orgId: string, managerId: string, input: CreateOneOnOneInput) {
    await this.assertOrgMember(orgId, input.employeeId);

    const scheduledTime = new Date(input.scheduledAt);
    const duplicate = await this.db.query.oneOnOneMeetings.findFirst({
      where: and(
        eq(oneOnOneMeetings.orgId, orgId),
        eq(oneOnOneMeetings.employeeId, input.employeeId),
        eq(oneOnOneMeetings.scheduledAt, scheduledTime),
      ),
      columns: { id: true },
    });
    if (duplicate) {
      throw new ConflictException(
        "A 1-on-1 is already scheduled with this employee at this time.",
      );
    }

    const [meeting] = await this.db
      .insert(oneOnOneMeetings)
      .values({
        orgId,
        managerId,
        employeeId: input.employeeId,
        scheduledAt: scheduledTime,
        duration: input.duration ?? 30,
        agenda: input.agenda,
        meetingLink: input.meetingLink || undefined,
        status: "SCHEDULED",
      })
      .returning();

    return meeting;
  }

  async updateOneOnOne(
    orgId: string,
    actorId: string,
    canManage: boolean,
    meetingId: number,
    input: UpdateOneOnOneInput,
  ) {
    const existing = await this.db.query.oneOnOneMeetings.findFirst({
      where: and(eq(oneOnOneMeetings.id, meetingId), eq(oneOnOneMeetings.orgId, orgId)),
      columns: { id: true, managerId: true, employeeId: true },
    });
    if (!existing) throw new NotFoundException("Meeting not found.");
    if (!canManage && existing.managerId !== actorId && existing.employeeId !== actorId) {
      throw new ForbiddenException("You can only modify your own 1-on-1 meetings.");
    }

    await this.db
      .update(oneOnOneMeetings)
      .set({
        ...(input.scheduledAt !== undefined && { scheduledAt: new Date(input.scheduledAt) }),
        ...(input.duration !== undefined && { duration: input.duration }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.notes !== undefined && { notes: input.notes }),
        ...(input.actionItems !== undefined && { actionItems: input.actionItems }),
        ...(input.agenda !== undefined && { agenda: input.agenda }),
        ...(input.meetingLink !== undefined && { meetingLink: input.meetingLink }),
        updatedAt: new Date(),
      })
      .where(and(eq(oneOnOneMeetings.id, meetingId), eq(oneOnOneMeetings.orgId, orgId)));

    return { success: true };
  }

  async deleteOneOnOne(orgId: string, actorId: string, canManage: boolean, meetingId: number) {
    const existing = await this.db.query.oneOnOneMeetings.findFirst({
      where: and(eq(oneOnOneMeetings.id, meetingId), eq(oneOnOneMeetings.orgId, orgId)),
      columns: { id: true, managerId: true, employeeId: true },
    });
    if (!existing) throw new NotFoundException("Meeting not found.");
    if (!canManage && existing.managerId !== actorId && existing.employeeId !== actorId) {
      throw new ForbiddenException("You can only delete your own 1-on-1 meetings.");
    }

    await this.db
      .delete(oneOnOneMeetings)
      .where(and(eq(oneOnOneMeetings.id, meetingId), eq(oneOnOneMeetings.orgId, orgId)));
    return { success: true };
  }

  listPips(orgId: string, userId: string, scope: DataScope) {
    const conditions = [
      eq(performanceImprovementPlans.orgId, orgId),
      applyScope(scope, userId, { ownerColumn: performanceImprovementPlans.userId }),
    ];

    return this.db.query.performanceImprovementPlans.findMany({
      where: and(...conditions),
      with: {
        user: { columns: { id: true, name: true, image: true } },
        manager: { columns: { id: true, name: true } },
        hrRep: { columns: { id: true, name: true } },
      },
      orderBy: [desc(performanceImprovementPlans.createdAt)],
      limit: 100,
    });
  }

  async createPip(orgId: string, managerId: string, input: CreatePipInput) {
    await this.assertOrgMember(orgId, input.userId);

    const [pip] = await this.db
      .insert(performanceImprovementPlans)
      .values({
        orgId,
        userId: input.userId,
        managerId,
        hrRepId: input.hrRepId || null,
        reason: input.reason,
        objectives: input.objectives,
        startDate: input.startDate,
        endDate: input.endDate,
        notes: input.notes,
        status: "ACTIVE",
      })
      .returning();

    return pip;
  }

  async updatePip(orgId: string, pipId: number, input: UpdatePipInput) {
    await this.db
      .update(performanceImprovementPlans)
      .set({
        ...(input.status !== undefined && { status: input.status }),
        ...(input.outcome !== undefined && { outcome: input.outcome }),
        ...(input.notes !== undefined && { notes: input.notes }),
        ...(input.endDate !== undefined && { endDate: input.endDate }),
        ...(input.reason !== undefined && { reason: input.reason }),
        ...(input.objectives !== undefined && { objectives: input.objectives }),
        ...(input.hrRepId !== undefined && { hrRepId: input.hrRepId }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(performanceImprovementPlans.id, pipId),
          eq(performanceImprovementPlans.orgId, orgId),
        ),
      );

    return { success: true };
  }

  listReviews(
    orgId: string,
    userId: string,
    scope: DataScope,
    filters: { userId?: string; cycleId?: number; limit?: number; offset?: number },
  ) {
    const conditions = [eq(performanceReviews.orgId, orgId)];
    conditions.push(applyScope(scope, userId, { ownerColumn: performanceReviews.userId }));
    if (filters.userId && scope === "all") {
      conditions.push(eq(performanceReviews.userId, filters.userId));
    }
    if (filters.cycleId) conditions.push(eq(performanceReviews.cycleId, filters.cycleId));

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
      where: and(eq(performanceReviews.id, reviewId), eq(performanceReviews.orgId, orgId)),
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
      where: and(eq(performanceReviews.id, reviewId), eq(performanceReviews.orgId, orgId)),
      columns: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException("Review not found.");
    if (existing.status === "COMPLETED") {
      throw new ConflictException("Completed reviews cannot be deleted.");
    }

    await this.db
      .delete(performanceReviews)
      .where(and(eq(performanceReviews.id, reviewId), eq(performanceReviews.orgId, orgId)));
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
      where: and(eq(performanceReviews.id, reviewId), eq(performanceReviews.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Review not found.");
    if (!canManage && existing.reviewerId !== actorId && existing.userId !== actorId) {
      throw new ForbiddenException("You can only edit reviews you are a participant in.");
    }

    if (existing.status === "COMPLETED") {
      if (
        input.periodStart !== undefined ||
        input.periodEnd !== undefined ||
        input.cycleId !== undefined
      ) {
        throw new ConflictException("Cannot edit period or cycle for a completed review.");
      }
      if (
        input.ratings !== undefined ||
        input.strengths !== undefined ||
        input.improvements !== undefined ||
        input.overallRating !== undefined ||
        input.comments !== undefined
      ) {
        throw new ConflictException("Cannot edit ratings, strengths, improvements, or comments on a completed review.");
      }
      if (input.status !== undefined && input.status !== "ARCHIVED") {
        throw new ConflictException("A completed review can only transition to ARCHIVED.");
      }
    }

    await this.db
      .update(performanceReviews)
      .set({
        ...(input.ratings !== undefined && { ratings: input.ratings }),
        ...(input.strengths !== undefined && { strengths: input.strengths }),
        ...(input.improvements !== undefined && { improvements: input.improvements }),
        ...(input.overallRating !== undefined && {
          overallRating: input.overallRating.toString(),
        }),
        ...(input.comments !== undefined && { comments: input.comments }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.periodStart !== undefined && { periodStart: input.periodStart }),
        ...(input.periodEnd !== undefined && { periodEnd: input.periodEnd }),
        ...(input.cycleId !== undefined && { cycleId: input.cycleId }),
        updatedAt: new Date(),
      })
      .where(and(eq(performanceReviews.id, reviewId), eq(performanceReviews.orgId, orgId)));

    return { success: true };
  }

  listCycles(orgId: string) {
    return this.db.query.reviewCycles.findMany({
      where: eq(reviewCycles.orgId, orgId),
      orderBy: [desc(reviewCycles.createdAt)],
      limit: 100,
    });
  }

  async getCycle(orgId: string, cycleId: number) {
    const cycle = await this.db.query.reviewCycles.findFirst({
      where: and(eq(reviewCycles.id, cycleId), eq(reviewCycles.orgId, orgId)),
    });
    if (!cycle) throw new NotFoundException("Review cycle not found.");

    const reviews = await this.db.query.performanceReviews.findMany({
      where: and(eq(performanceReviews.orgId, orgId), eq(performanceReviews.cycleId, cycleId)),
      columns: {
        id: true,
        userId: true,
        reviewerId: true,
        status: true,
        overallRating: true,
        periodStart: true,
        periodEnd: true,
        createdAt: true,
      },
      with: {
        user: { columns: { id: true, name: true, image: true } },
        reviewer: { columns: { id: true, name: true } },
      },
      orderBy: [desc(performanceReviews.createdAt)],
      limit: 100,
    });

    return { ...cycle, reviews };
  }

  async updateCycle(orgId: string, cycleId: number, input: UpdateReviewCycleInput) {
    const existing = await this.db.query.reviewCycles.findFirst({
      where: and(eq(reviewCycles.id, cycleId), eq(reviewCycles.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Review cycle not found.");

    await this.db
      .update(reviewCycles)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.type !== undefined && { type: input.type }),
        ...(input.periodStart !== undefined && { periodStart: input.periodStart }),
        ...(input.periodEnd !== undefined && { periodEnd: input.periodEnd }),
        ...(input.deadline !== undefined && { deadline: input.deadline }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.description !== undefined && { description: input.description }),
        updatedAt: new Date(),
      })
      .where(and(eq(reviewCycles.id, cycleId), eq(reviewCycles.orgId, orgId)));

    return { success: true };
  }

  async deleteCycle(orgId: string, cycleId: number) {
    await this.db
      .delete(reviewCycles)
      .where(and(eq(reviewCycles.id, cycleId), eq(reviewCycles.orgId, orgId)));
    return { success: true };
  }

  private async assertOrgMember(orgId: string, userId: string): Promise<void> {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)),
      columns: { id: true },
    });
    if (!member) throw new NotFoundException("Employee not found in your organization.");
  }
}
