import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, gte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { subDays } from "date-fns";
import { loginHistory, userSessions } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { getTenantContext, withTenant } from "../../common/tenant";
import { logger } from "../../common/logger/logger.service";
import { keysetBefore } from "../../common/pagination/keyset";
import { buildCursorPage, decodeCursor, type CursorPage } from "../../common/pagination/cursor";

@Injectable()
export class AuthAnalyticsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async logLoginEvent(
    userId: string | null,
    orgId: string | null,
    event: string,
    success: boolean,
    failureReason: string | null,
    context: { ipAddress?: string; userAgent?: string },
  ): Promise<void> {
    if (!userId) return;
    const values = {
      id: randomUUID(),
      userId,
      orgId,
      event,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      success,
      failureReason,
    };

    try {
      if (orgId && !getTenantContext()) {
        await withTenant(this.db, { orgId, audience: "INTERNAL" }, async (tx) => {
          await tx.insert(loginHistory).values(values);
        });
        return;
      }
      await this.db.insert(loginHistory).values(values);
    } catch (error: unknown) {
      logger.error("login history write failed", { error, event, userId });
    }
  }

  async getAuditAnalytics(): Promise<{
    loginsToday: number;
    failedLoginsLast7Days: number;
    activeSessions: number;
  }> {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const sevenDaysAgo = subDays(now, 7);

    const [loginsTodayResult, failedLoginsResult, activeSessionsResult] =
      await Promise.all([
        this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(loginHistory)
          .where(
            and(
              eq(loginHistory.success, true),
              gte(loginHistory.createdAt, startOfToday),
            ),
          ),
        this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(loginHistory)
          .where(
            and(
              eq(loginHistory.success, false),
              gte(loginHistory.createdAt, sevenDaysAgo),
            ),
          ),
        this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(userSessions)
          .where(
            and(eq(userSessions.isRevoked, false), gt(userSessions.expiresAt, now)),
          ),
      ]);

    return {
      loginsToday: loginsTodayResult[0]?.count ?? 0,
      failedLoginsLast7Days: failedLoginsResult[0]?.count ?? 0,
      activeSessions: activeSessionsResult[0]?.count ?? 0,
    };
  }

  async listLoginHistory(
    userId: string,
    limit: number,
    cursor?: string,
    successFilter?: boolean,
  ): Promise<CursorPage<{ id: string; event: string; success: boolean; createdAt: Date; ipAddress: string | null; userAgent: string | null }>> {
    const cap = Math.min(limit, 100);
    const pos = decodeCursor(cursor);
    const conditions = [eq(loginHistory.userId, userId)];
    if (successFilter !== undefined) conditions.push(eq(loginHistory.success, successFilter));
    if (pos) conditions.push(keysetBefore(loginHistory.createdAt, loginHistory.id, pos));

    const rows = await this.db
      .select({
        id: loginHistory.id,
        event: loginHistory.event,
        success: loginHistory.success,
        createdAt: loginHistory.createdAt,
        ipAddress: loginHistory.ipAddress,
        userAgent: loginHistory.userAgent,
      })
      .from(loginHistory)
      .where(and(...conditions))
      .orderBy(desc(loginHistory.createdAt), desc(loginHistory.id))
      .limit(cap + 1);

    return buildCursorPage(rows, cap, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: row.id,
    }));
  }
}
