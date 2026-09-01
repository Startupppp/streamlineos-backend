import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  performanceReviews,
  reviewCycles,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AutomationService } from "../../automation/automation.service";
import type {
  CreateReviewCycleInput,
  UpdateReviewCycleInput,
} from "./dto/performance.schemas";

@Injectable()
export class ReviewCyclesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly automation: AutomationService,
  ) {}

  async createCycle(orgId: string, actorId: string, input: CreateReviewCycleInput) {
    const existing = await this.db.query.reviewCycles.findFirst({
      where: and(eq(reviewCycles.orgId, orgId), eq(reviewCycles.name, input.name)),
      columns: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        `A review cycle named "${input.name}" already exists.`,
      );
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

    void this.automation.runAutomationsForEvent(
      orgId,
      "performance.review_cycle_started",
      {
        cycleId: cycle.id,
        cycleName: cycle.name,
        startDate: cycle.periodStart,
        endDate: cycle.periodEnd,
        reviewerCount: 0,
      },
    );

    return cycle;
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
        limit: 100,
      where: and(
        eq(performanceReviews.orgId, orgId),
        eq(performanceReviews.cycleId, cycleId),
      ),
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
        ...(input.periodStart !== undefined && {
          periodStart: input.periodStart,
        }),
        ...(input.periodEnd !== undefined && { periodEnd: input.periodEnd }),
        ...(input.deadline !== undefined && { deadline: input.deadline }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
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
}
