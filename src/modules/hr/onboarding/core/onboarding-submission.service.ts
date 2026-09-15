import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { AuditService } from "../../../../common/audit/audit.service";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { CacheService } from "../../../../common/cache/cache.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import {
  leaveBalances,
  leaveTypes,
  onboardingAnalyticsEvents,
  onboardingFlowSessions,
  onboardingSteps,
  organizationMembers,
  users,
} from "../../../../db/schema";

@Injectable()
export class OnboardingSubmissionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async complete(orgId: string, userId: string): Promise<{ completedAt: Date; leaveBalancesAllocated: number }> {
    const { completedAt, leaveBalancesAllocated } = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${orgId}:${userId}:onboarding`}, 0))`,
      );
      const [membership] = await tx
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        )
        .limit(1)
        .for("update");
      if (!membership)
        throw new NotFoundException("User not found in this organization.");

      await this.completeFinalReview(tx, orgId, userId);
      const allocated = await this.initializeLeaveBalances(tx, orgId, userId);
      await this.completeFlowSession(tx, orgId, userId);
      const at = new Date();
      await tx
        .update(organizationMembers)
        .set({ onboardingCompletedAt: at })
        .where(eq(organizationMembers.id, membership.id));
      await tx
        .update(users)
        .set({ onboardingCompletedAt: at })
        .where(eq(users.id, userId));
      await tx.insert(onboardingAnalyticsEvents).values({
        orgId,
        userId,
        eventType: "employee_onboarding_completed",
        source: "session",
        metadata: {},
      });
      await this.audit.logCritical({
        orgId,
        userId,
        action: "hr.onboarding.submitted",
        targetId: userId,
        targetType: "organization_member",
        metadata: { membershipId: membership.id },
      });
      return { completedAt: at, leaveBalancesAllocated: allocated };
    });

    await this.cache.invalidate(CACHE_KEYS.userSession(userId));
    return { completedAt, leaveBalancesAllocated };
  }

  private async completeFinalReview(
    tx: Db,
    orgId: string,
    userId: string,
  ): Promise<void> {
    const [existing] = await tx
      .select({ id: onboardingSteps.id })
      .from(onboardingSteps)
      .where(
        and(
          eq(onboardingSteps.userId, userId),
          eq(onboardingSteps.orgId, orgId),
          eq(onboardingSteps.stepName, "Final Review"),
        ),
      )
      .limit(1)
      .for("update");
    if (existing) {
      await tx
        .update(onboardingSteps)
        .set({ status: "COMPLETED", completedAt: new Date() })
        .where(
          and(
            eq(onboardingSteps.id, existing.id),
            eq(onboardingSteps.orgId, orgId),
          ),
        );
      return;
    }
    await tx.insert(onboardingSteps).values({
      userId,
      orgId,
      stepName: "Final Review",
      status: "COMPLETED",
      completedAt: new Date(),
    });
  }

  private async initializeLeaveBalances(
    tx: Db,
    orgId: string,
    userId: string,
  ): Promise<number> {
    const year = new Date().getFullYear();
    const [types, balances] = await Promise.all([
      tx
        .select({ id: leaveTypes.id, daysPerYear: leaveTypes.daysPerYear })
        .from(leaveTypes)
        .where(eq(leaveTypes.orgId, orgId))
        .limit(1_000),
      tx
        .select({ leaveTypeId: leaveBalances.leaveTypeId })
        .from(leaveBalances)
        .where(
          and(
            eq(leaveBalances.orgId, orgId),
            eq(leaveBalances.userId, userId),
            eq(leaveBalances.year, year),
          ),
        )
        .limit(1_000),
    ]);
    const existingIds = new Set(balances.map((balance) => balance.leaveTypeId));
    const missing = types.filter((type) => !existingIds.has(type.id));
    if (missing.length === 0) return 0;
    await tx.insert(leaveBalances).values(
      missing.map((type) => ({
        orgId,
        userId,
        leaveTypeId: type.id,
        balance: String(type.daysPerYear),
        year,
      })),
    );
    return missing.length;
  }

  private async completeFlowSession(
    tx: Db,
    orgId: string,
    userId: string,
  ): Promise<void> {
    const [session] = await tx
      .select({ id: onboardingFlowSessions.id })
      .from(onboardingFlowSessions)
      .where(
        and(
          eq(onboardingFlowSessions.orgId, orgId),
          eq(onboardingFlowSessions.userId, userId),
          eq(onboardingFlowSessions.type, "employee_onboarding"),
          inArray(onboardingFlowSessions.status, [
            "not_started",
            "in_progress",
            "completed",
          ]),
        ),
      )
      .orderBy(
        desc(onboardingFlowSessions.createdAt),
        desc(onboardingFlowSessions.id),
      )
      .limit(1)
      .for("update");
    if (session) {
      await tx
        .update(onboardingFlowSessions)
        .set({
          status: "completed",
          completedAt: new Date(),
          lastSeenAt: new Date(),
        })
        .where(
          and(
            eq(onboardingFlowSessions.id, session.id),
            eq(onboardingFlowSessions.orgId, orgId),
          ),
        );
      return;
    }
    await tx.insert(onboardingFlowSessions).values({
      orgId,
      userId,
      type: "employee_onboarding",
      status: "completed",
      startedAt: new Date(),
      completedAt: new Date(),
      lastSeenAt: new Date(),
    });
  }
}
