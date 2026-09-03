import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { goals, keyResults, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import { formatDateOnly } from "../../../common/date";
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
      limit: 100,
    });

    const goalIds = myGoals.map((g) => g.id);
    const allKeyResults =
      goalIds.length > 0
        ? await this.db.query.keyResults.findMany({
            where: inArray(keyResults.goalId, goalIds),
            limit: 100,
          })
        : [];

    return { goals: myGoals, keyResults: allKeyResults };
  }

  listGoals(orgId: string, userId: string, scope: DataScope, filterUserId?: string) {
    const conditions = [eq(goals.orgId, orgId)];
    conditions.push(applyScope(scope, orgId, userId, { ownerColumn: goals.userId }));
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
    await this.assertOrgMember(orgId, input.userId);

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
        startDate: formatDateOnly(input.startDate),
        endDate: formatDateOnly(input.endDate),
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

  async updateGoalItem(
    orgId: string,
    actorId: string,
    canManage: boolean,
    goalId: number,
    input: UpdateGoalItemInput,
  ) {
    const existing = await this.db.query.goals.findFirst({
      where: and(eq(goals.id, goalId), eq(goals.orgId, orgId)),
      columns: { id: true, userId: true },
    });
    if (!existing) throw new NotFoundException("Goal not found.");
    if (!canManage && existing.userId !== actorId) {
      throw new ForbiddenException("You can only update your own goals.");
    }

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
      .where(and(eq(goals.id, goalId), eq(goals.orgId, orgId)));

    return { success: true };
  }

  async deleteGoal(orgId: string, goalId: number) {
    await this.db.delete(goals).where(and(eq(goals.id, goalId), eq(goals.orgId, orgId)));
    return { success: true };
  }

  async listKeyResults(orgId: string, goalId: number) {
    const goal = await this.db.query.goals.findFirst({
      columns: { id: true },
      where: and(eq(goals.id, goalId), eq(goals.orgId, orgId)),
    });
    if (!goal) throw new NotFoundException("Goal not found.");

    return this.db.query.keyResults.findMany({
      where: eq(keyResults.goalId, goalId),
      limit: 100,
    });
  }

  async createKeyResult(orgId: string, actorId: string, canManage: boolean, input: CreateKeyResultInput) {
    const goal = await this.db.query.goals.findFirst({
      where: and(eq(goals.id, input.goalId), eq(goals.orgId, orgId)),
      columns: { id: true, userId: true },
    });
    if (!goal) throw new NotFoundException("Goal not found.");
    if (!canManage && goal.userId !== actorId) {
      throw new ForbiddenException("You can only add key results to your own goals.");
    }

    const [kr] = await this.db
      .insert(keyResults)
      .values({
        orgId,
        goalId: input.goalId,
        title: input.title,
        targetValue: input.targetValue?.toString(),
        unit: input.unit,
      })
      .returning();

    return kr;
  }

  async updateKeyResult(orgId: string, input: UpdateKeyResultInput) {
    const owned = await this.db
      .select({ id: keyResults.id })
      .from(keyResults)
      .innerJoin(goals, eq(goals.id, keyResults.goalId))
      .where(and(eq(keyResults.id, input.id), eq(goals.orgId, orgId)))
      .limit(1);
    if (!owned[0]) throw new NotFoundException("Key result not found.");

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

  async sweepOverdueGoals(orgId?: string) {
    const today = new Date().toISOString().slice(0, 10);
    const conditions = [
      eq(goals.status, "IN_PROGRESS"),
      lt(goals.endDate, today),
    ];
    if (orgId) conditions.push(eq(goals.orgId, orgId));
    const overdueGoals = await this.db
      .select({ id: goals.id, orgId: goals.orgId, userId: goals.userId })
      .from(goals)
      .where(and(...conditions))
      .limit(500);
    return overdueGoals;
  }

  private async assertOrgMember(orgId: string, userId: string): Promise<void> {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)),
      columns: { id: true },
    });
    if (!member) throw new NotFoundException("Employee not found in your organization.");
  }
}
