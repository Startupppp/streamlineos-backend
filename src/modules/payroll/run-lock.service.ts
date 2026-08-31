import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { payrollRuns } from "../../db/schema";

const LOCK_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class PayrollRunLockService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async acquire(orgId: string, runId: number): Promise<string> {
    const token = randomUUID();
    const staleBefore = new Date(Date.now() - LOCK_TTL_MS);

    const updated = await this.db
      .update(payrollRuns)
      .set({
        generationLockToken: token,
        generationLockedAt: new Date(),
      })
      .where(
        and(
          eq(payrollRuns.id, runId),
          eq(payrollRuns.orgId, orgId),
          or(
            isNull(payrollRuns.generationLockToken),
            isNull(payrollRuns.generationLockedAt),
            lt(payrollRuns.generationLockedAt, staleBefore),
          ),
        ),
      )
      .returning({ id: payrollRuns.id, generationLockToken: payrollRuns.generationLockToken });

    if (!updated[0] || updated[0].generationLockToken !== token) {
      throw new ConflictException(
        "Payroll run is already being generated or recalculated. Retry shortly.",
      );
    }
    return token;
  }

  async release(orgId: string, runId: number, token: string): Promise<void> {
    await this.db
      .update(payrollRuns)
      .set({
        generationLockToken: null,
        generationLockedAt: null,
      })
      .where(
        and(
          eq(payrollRuns.id, runId),
          eq(payrollRuns.orgId, orgId),
          eq(payrollRuns.generationLockToken, token),
        ),
      );
  }

  async assertNoOtherActiveGeneration(orgId: string, month: string, runId: number): Promise<void> {
    const staleBefore = new Date(Date.now() - LOCK_TTL_MS);
    const others = await this.db
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.orgId, orgId),
          eq(payrollRuns.month, month),
          sql`${payrollRuns.id} <> ${runId}`,
          sql`${payrollRuns.generationLockToken} IS NOT NULL`,
          sql`${payrollRuns.generationLockedAt} IS NOT NULL`,
          sql`${payrollRuns.generationLockedAt} >= ${staleBefore.toISOString()}::timestamptz`,
        ),
      )
      .limit(1);

    if (others[0]) {
      throw new ConflictException(
        "Another payroll generation for this period is already in progress.",
      );
    }
  }
}
