import { ForbiddenException } from "@nestjs/common";
import { eq, and, sql } from "drizzle-orm";
import { type Db } from "../../db/drizzle.module";
import { orgLimits } from "../../db/schema/access";

export async function checkLimit(db: Db, orgId: string, limitKey: string): Promise<void> {
  const [row] = await db
    .select()
    .from(orgLimits)
    .where(and(eq(orgLimits.orgId, orgId), eq(orgLimits.limitKey, limitKey)))
    .limit(1);

  if (!row) return;

  if (row.usedValue >= row.limitValue) {
    throw new ForbiddenException({
      error: "Limit reached",
      code: "LIMIT_REACHED",
      limitKey,
      limit: row.limitValue,
      used: row.usedValue,
    });
  }
}

export async function incrementLimit(db: Db, orgId: string, limitKey: string, delta = 1): Promise<void> {
  await db
    .update(orgLimits)
    .set({ usedValue: sql`${orgLimits.usedValue} + ${delta}`, updatedAt: sql`now()` })
    .where(and(eq(orgLimits.orgId, orgId), eq(orgLimits.limitKey, limitKey)));
}

export async function decrementLimit(db: Db, orgId: string, limitKey: string, delta = 1): Promise<void> {
  await db
    .update(orgLimits)
    .set({ usedValue: sql`GREATEST(${orgLimits.usedValue} - ${delta}, 0)`, updatedAt: sql`now()` })
    .where(and(eq(orgLimits.orgId, orgId), eq(orgLimits.limitKey, limitKey)));
}
