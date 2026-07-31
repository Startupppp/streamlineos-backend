import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { onboardingFlowSessions } from "../../../../db/schema";
import { OnboardingAnalyticsService } from "./onboarding-analytics.service";

type OnboardingFlowType =
  | "org_setup"
  | "member_setup"
  | "employee_onboarding"
  | "module_setup"
  | "guided_tour"
  | "payment_setup";

export interface SessionPatch {
  currentStep?: string;
  data?: Record<string, unknown>;
  completedSteps?: string[];
  skippedSteps?: string[];
  source?: string;
}

@Injectable()
export class OnboardingSessionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly analytics: OnboardingAnalyticsService,
  ) {}

  async getOrCreateSession(orgId: string, userId: string, type: OnboardingFlowType) {
    const existing = await this.db.query.onboardingFlowSessions.findFirst({
      where: and(
        eq(onboardingFlowSessions.orgId, orgId),
        eq(onboardingFlowSessions.userId, userId),
        eq(onboardingFlowSessions.type, type),
      ),
      orderBy: desc(onboardingFlowSessions.createdAt),
    });
    if (existing && existing.status !== "abandoned") {
      return existing;
    }

    const [created] = await this.db
      .insert(onboardingFlowSessions)
      .values({ orgId, userId, type, status: "not_started", startedAt: new Date() })
      .returning();

    await this.analytics.track(orgId, userId, `${type}_started`, { source: "session" });
    return created;
  }

  async patchSession(orgId: string, userId: string, type: OnboardingFlowType, patch: SessionPatch) {
    const session = await this.getOrCreateSession(orgId, userId, type);

    const [updated] = await this.db
      .update(onboardingFlowSessions)
      .set({
        status: session.status === "not_started" ? "in_progress" : session.status,
        ...(patch.currentStep !== undefined ? { currentStep: patch.currentStep } : {}),
        ...(patch.data !== undefined ? { data: { ...(session.data as object), ...patch.data } } : {}),
        ...(patch.completedSteps !== undefined ? { completedSteps: patch.completedSteps } : {}),
        ...(patch.skippedSteps !== undefined ? { skippedSteps: patch.skippedSteps } : {}),
        ...(patch.source !== undefined ? { source: patch.source } : {}),
        lastSeenAt: new Date(),
      })
      .where(eq(onboardingFlowSessions.id, session.id))
      .returning();

    return updated;
  }

  async completeSession(orgId: string, userId: string, type: OnboardingFlowType) {
    const session = await this.getOrCreateSession(orgId, userId, type);
    const [updated] = await this.db
      .update(onboardingFlowSessions)
      .set({ status: "completed", completedAt: new Date(), lastSeenAt: new Date() })
      .where(eq(onboardingFlowSessions.id, session.id))
      .returning();

    await this.analytics.track(orgId, userId, `${type}_completed`, { source: "session" });
    return updated;
  }

  async skipSession(orgId: string, userId: string, type: OnboardingFlowType, reason?: string) {
    const session = await this.getOrCreateSession(orgId, userId, type);
    const [updated] = await this.db
      .update(onboardingFlowSessions)
      .set({
        status: "skipped",
        completedAt: new Date(),
        lastSeenAt: new Date(),
        data: { ...(session.data as object), skipReason: reason },
      })
      .where(eq(onboardingFlowSessions.id, session.id))
      .returning();

    await this.analytics.track(orgId, userId, `${type}_skipped`, { source: "session", metadata: { reason } });
    return updated;
  }
}
