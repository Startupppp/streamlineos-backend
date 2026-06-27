import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, or } from "drizzle-orm";
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
      with: { manager: true, employee: true },
      orderBy: [desc(oneOnOneMeetings.scheduledAt)],
    });

    return data.map((m) => ({
      ...m,
      scheduledAt:
        m.scheduledAt instanceof Date ? m.scheduledAt.toISOString() : m.scheduledAt,
    }));
  }

  async createOneOnOne(orgId: string, managerId: string, input: CreateOneOnOneInput) {
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

  async updateOneOnOne(orgId: string, meetingId: number, input: UpdateOneOnOneInput) {
    const existing = await this.db.query.oneOnOneMeetings.findFirst({
      where: and(eq(oneOnOneMeetings.id, meetingId), eq(oneOnOneMeetings.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Meeting not found.");

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
      .where(eq(oneOnOneMeetings.id, meetingId));

    return { success: true };
  }

  async deleteOneOnOne(orgId: string, meetingId: number) {
    await this.db
      .delete(oneOnOneMeetings)
      .where(and(eq(oneOnOneMeetings.id, meetingId), eq(oneOnOneMeetings.orgId, orgId)));
    return { success: true };
  }

  listPips(orgId: string, userId: string, isAdmin: boolean) {
    const conditions = [eq(performanceImprovementPlans.orgId, orgId)];
    if (!isAdmin) conditions.push(eq(performanceImprovementPlans.userId, userId));

    return this.db.query.performanceImprovementPlans.findMany({
      where: and(...conditions),
      with: { user: true, manager: true, hrRep: true },
      orderBy: [desc(performanceImprovementPlans.createdAt)],
    });
  }

  async createPip(orgId: string, managerId: string, input: CreatePipInput) {
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

  async getReview(orgId: string, reviewId: number) {
    const review = await this.db.query.performanceReviews.findFirst({
      where: and(eq(performanceReviews.id, reviewId), eq(performanceReviews.orgId, orgId)),
      with: { user: true, reviewer: true, cycle: true },
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

  async updateReview(orgId: string, reviewId: number, input: UpdatePerformanceReviewInput) {
    const existing = await this.db.query.performanceReviews.findFirst({
      where: and(eq(performanceReviews.id, reviewId), eq(performanceReviews.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Review not found.");

    if (
      existing.status === "COMPLETED" &&
      (input.periodStart !== undefined ||
        input.periodEnd !== undefined ||
        input.cycleId !== undefined)
    ) {
      throw new ConflictException("Cannot edit period or cycle for a completed review.");
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
      .where(eq(performanceReviews.id, reviewId));

    return { success: true };
  }

  async getCycle(orgId: string, cycleId: number) {
    const cycle = await this.db.query.reviewCycles.findFirst({
      where: and(eq(reviewCycles.id, cycleId), eq(reviewCycles.orgId, orgId)),
      with: { reviews: true },
    });
    if (!cycle) throw new NotFoundException("Review cycle not found.");
    return cycle;
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
      .where(eq(reviewCycles.id, cycleId));

    return { success: true };
  }

  async deleteCycle(orgId: string, cycleId: number) {
    await this.db
      .delete(reviewCycles)
      .where(and(eq(reviewCycles.id, cycleId), eq(reviewCycles.orgId, orgId)));
    return { success: true };
  }
}
