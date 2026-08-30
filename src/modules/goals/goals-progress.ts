import { and, eq } from "drizzle-orm";
import { okrGoals, okrKeyResults } from "../../db/schema";
import type { Db } from "../../db/drizzle.types";

function keyResultPercent(kr: {
  metricType: "number" | "percentage" | "currency" | "boolean";
  startValue: string;
  targetValue: string;
  currentValue: string;
}): number {
  if (kr.metricType === "boolean")
    return parseFloat(kr.currentValue) >= 1 ? 100 : 0;
  const start = parseFloat(kr.startValue);
  const target = parseFloat(kr.targetValue);
  const current = parseFloat(kr.currentValue);
  const denominator = target - start;
  if (denominator === 0) return current >= target ? 100 : 0;
  const raw = ((current - start) / denominator) * 100;
  if (Number.isNaN(raw)) return 0;
  return Math.min(Math.max(raw, 0), 100);
}

export async function recomputeGoalProgress(
  db: Db,
  goalId: number,
  orgId: string,
): Promise<number | null> {
  return db.transaction(async (tx) => {
    const keyResults = await tx.query.okrKeyResults.findMany({
      where: and(
        eq(okrKeyResults.goalId, goalId),
        eq(okrKeyResults.orgId, orgId),
      ),
      columns: {
        metricType: true,
        startValue: true,
        targetValue: true,
        currentValue: true,
      },
    });

    if (keyResults.length === 0) return null;

    const total = keyResults.reduce(
      (sum, kr) => sum + keyResultPercent(kr),
      0,
    );
    const progress = Math.round(total / keyResults.length);

    await tx
      .update(okrGoals)
      .set({ progress, updatedAt: new Date() })
      .where(and(eq(okrGoals.id, goalId), eq(okrGoals.orgId, orgId)));

    return progress;
  });
}
