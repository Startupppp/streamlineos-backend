import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { guidedTours, userTourProgress } from "../../db/schema";
import { OnboardingAnalyticsService } from "./onboarding-analytics.service";

@Injectable()
export class GuidedTourService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly analytics: OnboardingAnalyticsService,
  ) {}

  async listToursForUser(orgId: string, userId: string, role?: string) {
    const tours = await this.db.query.guidedTours.findMany({
      where: and(
        or(eq(guidedTours.orgId, orgId), isNull(guidedTours.orgId)),
        eq(guidedTours.isActive, true),
      ),
    });
    const relevant = role ? tours.filter((t) => !t.role || t.role === role) : tours;

    const progressRows = await this.db.query.userTourProgress.findMany({
      where: and(eq(userTourProgress.orgId, orgId), eq(userTourProgress.userId, userId)),
    });
    const progressByKey = new Map(progressRows.map((p) => [p.tourKey, p]));

    return relevant.map((tour) => ({
      ...tour,
      progress: progressByKey.get(tour.tourKey) ?? null,
    }));
  }

  private async getOrCreateProgress(orgId: string, userId: string, tourKey: string) {
    const existing = await this.db.query.userTourProgress.findFirst({
      where: and(
        eq(userTourProgress.orgId, orgId),
        eq(userTourProgress.userId, userId),
        eq(userTourProgress.tourKey, tourKey),
      ),
    });
    if (existing) return existing;

    const [created] = await this.db
      .insert(userTourProgress)
      .values({ orgId, userId, tourKey, status: "in_progress", currentStep: 0 })
      .returning();
    return created;
  }

  async saveProgress(orgId: string, userId: string, tourKey: string, currentStep: number) {
    const progress = await this.getOrCreateProgress(orgId, userId, tourKey);
    const [updated] = await this.db
      .update(userTourProgress)
      .set({ status: "in_progress", currentStep })
      .where(eq(userTourProgress.id, progress.id))
      .returning();
    return updated;
  }

  async completeTour(orgId: string, userId: string, tourKey: string) {
    const progress = await this.getOrCreateProgress(orgId, userId, tourKey);
    const [updated] = await this.db
      .update(userTourProgress)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(userTourProgress.id, progress.id))
      .returning();
    await this.analytics.track(orgId, userId, "guided_tour_completed", { stepKey: tourKey });
    return updated;
  }

  async dismissTour(orgId: string, userId: string, tourKey: string) {
    const progress = await this.getOrCreateProgress(orgId, userId, tourKey);
    const [updated] = await this.db
      .update(userTourProgress)
      .set({ status: "dismissed", dismissedAt: new Date() })
      .where(eq(userTourProgress.id, progress.id))
      .returning();
    await this.analytics.track(orgId, userId, "guided_tour_dismissed", { stepKey: tourKey });
    return updated;
  }
}
