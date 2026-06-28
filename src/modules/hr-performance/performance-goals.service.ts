import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { goals, keyResults } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import { formatDateOnly } from "./date.helpers";
import type {
  CreateGoalInput,
  CreateKeyResultInput,
  UpdateGoalCollectionInput,
  UpdateGoalItemInput,
  UpdateKeyResultInput,
} from "./dto/performance.schemas";

@Injectable()
export class PerformanceGoalsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async myGoals(orgId: string, userId: string) {
    const myGoals = await this.db.query.goals.findMany({
      where: and(eq(goals.orgId, orgId), eq(goals.userId, userId)),
      orderBy: [desc(goals.createdAt)],
    });

    const goalIds = myGoals.map((g) => g.id);
    const allKeyResults =
      goalIds.length > 0
        ? await this.db.query.keyResults.findMany({
            where: inArray(keyResults.goalId, goalIds),
          })
        : [];

    return { goals: myGoals, keyResults: allKeyResults };
  }

  listGoals(orgId: string, userId: string, scope: DataScope, filterUserId?: string) {
    const conditions = [eq(goals.orgId, orgId)];
    conditions.push(applyScope(scope, userId, { ownerColumn: goals.userId }));
    if (filterUserId && scope === "all") {
      conditions.push(eq(goals.userId, filterUserId));
    }

    return this.db.query.goals.findMany({
      where: and(...conditions),
      orderBy: [desc(goals.createdAt)],
      limit: 100,
    });
  }

  async createGoal(orgId: string, input: CreateGoalInput) {
    const [goal] = await this.db
      .insert(goals)
      .values({
        orgId,
        userId: input.userId,
        title: input.title,
        description: input.description,
        type: input.type,
        targetValue: input.targetValue?.toString(),
        currentValue: (input.currentValue ?? 0).toString(),
        unit: input.unit,
        startDate: formatDateOnly(new Date(input.startDate)),
        endDate: formatDateOnly(new Date(input.endDate)),
        status: "IN_PROGRESS",
        progress: 0,
        parentGoalId: input.parentGoalId,
      })
      .returning();

    return goal;
  }

  async updateGoalFromCollection(orgId: string, input: UpdateGoalCollectionInput) {
    await this.db
      .update(goals)
      .set({
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.targetValue !== undefined && { targetValue: input.targetValue.toString() }),
        ...(input.currentValue !== undefined && { currentValue: input.currentValue.toString() }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.progress !== undefined && { progress: input.progress }),
        updatedAt: new Date(),
      })
      .where(and(eq(goals.id, input.goalId), eq(goals.orgId, orgId)));

    return { success: true };
  }

  async updateGoalItem(orgId: string, goalId: number, input: UpdateGoalItemInput) {
    const existing = await this.db.query.goals.findFirst({
      where: and(eq(goals.id, goalId), eq(goals.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Goal not found.");

    await this.db
      .update(goals)
      .set({
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.targetValue !== undefined && { targetValue: input.targetValue.toString() }),
        ...(input.currentValue !== undefined && { currentValue: input.currentValue.toString() }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.progress !== undefined && { progress: input.progress }),
        ...(input.startDate !== undefined && { startDate: input.startDate }),
        ...(input.endDate !== undefined && { endDate: input.endDate }),
        updatedAt: new Date(),
      })
      .where(eq(goals.id, goalId));

    return { success: true };
  }

  async deleteGoal(orgId: string, goalId: number) {
    await this.db.delete(goals).where(and(eq(goals.id, goalId), eq(goals.orgId, orgId)));
    return { success: true };
  }

  async listKeyResults(orgId: string, goalId: number) {
    const goal = await this.db.query.goals.findFirst({
      where: and(eq(goals.id, goalId), eq(goals.orgId, orgId)),
    });
    if (!goal) throw new NotFoundException("Goal not found.");

    return this.db.query.keyResults.findMany({
      where: eq(keyResults.goalId, goalId),
      limit: 100,
    });
  }

  async createKeyResult(orgId: string, input: CreateKeyResultInput) {
    const goal = await this.db.query.goals.findFirst({
      where: and(eq(goals.id, input.goalId), eq(goals.orgId, orgId)),
    });
    if (!goal) throw new NotFoundException("Goal not found.");

    const [kr] = await this.db
      .insert(keyResults)
      .values({
        goalId: input.goalId,
        title: input.title,
        targetValue: input.targetValue?.toString(),
        unit: input.unit,
      })
      .returning();

    return kr;
  }

  async updateKeyResult(input: UpdateKeyResultInput) {
    await this.db
      .update(keyResults)
      .set({
        ...(input.currentValue !== undefined && { currentValue: input.currentValue.toString() }),
        ...(input.progress !== undefined && { progress: input.progress }),
        updatedAt: new Date(),
      })
      .where(eq(keyResults.id, input.id));

    return { success: true };
  }
}
