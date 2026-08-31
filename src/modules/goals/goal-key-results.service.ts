import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { okrGoals, okrKeyResults } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { recomputeGoalProgress } from "./goals-progress";
import type {
  CreateKeyResultInput,
  UpdateKeyResultInput,
} from "./dto/goal.schemas";

@Injectable()
export class GoalKeyResultsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listKeyResults(orgId: string, goalId: number): Promise<Array<typeof okrKeyResults.$inferSelect>> {
    return this.db.query.okrKeyResults.findMany({
      where: and(
        eq(okrKeyResults.goalId, goalId),
        eq(okrKeyResults.orgId, orgId),
      ),
      orderBy: [okrKeyResults.id],
    });
  }

  async createKeyResult(
    orgId: string,
    goalId: number,
    input: CreateKeyResultInput,
  ): Promise<typeof okrKeyResults.$inferSelect | null> {
    const goal = await this.db.query.okrGoals.findFirst({
      where: and(eq(okrGoals.id, goalId), eq(okrGoals.orgId, orgId)),
      columns: { id: true },
    });
    if (!goal) return null;

    const [keyResult] = await this.db
      .insert(okrKeyResults)
      .values({
        orgId,
        goalId,
        title: input.title,
        metricType: input.metricType,
        startValue: input.startValue.toString(),
        targetValue: input.targetValue.toString(),
        currentValue: input.currentValue.toString(),
        unit: input.unit ?? null,
        status: input.status,
      })
      .returning();

    await recomputeGoalProgress(this.db, goalId, orgId);

    return keyResult ?? null;
  }

  async updateKeyResult(
    orgId: string,
    keyResultId: number,
    input: UpdateKeyResultInput,
  ): Promise<typeof okrKeyResults.$inferSelect | null> {
    const existing = await this.db.query.okrKeyResults.findFirst({
      where: and(
        eq(okrKeyResults.id, keyResultId),
        eq(okrKeyResults.orgId, orgId),
      ),
      columns: { id: true, goalId: true },
    });
    if (!existing) return null;

    const patch: Partial<typeof okrKeyResults.$inferInsert> & { updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (input.title !== undefined) patch.title = input.title;
    if (input.metricType !== undefined) patch.metricType = input.metricType;
    if (input.startValue !== undefined) patch.startValue = input.startValue.toString();
    if (input.targetValue !== undefined) patch.targetValue = input.targetValue.toString();
    if (input.currentValue !== undefined) patch.currentValue = input.currentValue.toString();
    if (input.unit !== undefined) patch.unit = input.unit;
    if (input.status !== undefined) patch.status = input.status;

    const [updated] = await this.db
      .update(okrKeyResults)
      .set(patch)
      .where(
        and(eq(okrKeyResults.id, keyResultId), eq(okrKeyResults.orgId, orgId)),
      )
      .returning();

    await recomputeGoalProgress(this.db, existing.goalId, orgId);

    return updated ?? null;
  }

  async removeKeyResult(orgId: string, keyResultId: number): Promise<{ success: true } | null> {
    const existing = await this.db.query.okrKeyResults.findFirst({
      where: and(
        eq(okrKeyResults.id, keyResultId),
        eq(okrKeyResults.orgId, orgId),
      ),
      columns: { id: true, goalId: true },
    });
    if (!existing) return null;

    await this.db
      .delete(okrKeyResults)
      .where(
        and(eq(okrKeyResults.id, keyResultId), eq(okrKeyResults.orgId, orgId)),
      );

    await recomputeGoalProgress(this.db, existing.goalId, orgId);

    return { success: true };
  }
}
