import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, or } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { guidedTours, userTourProgress } from "../../../../db/schema";
import { OnboardingAnalyticsService } from "./onboarding-analytics.service";

export const HR_SETUP_TOUR_KEY = "hr_setup";

@Injectable()
export class GuidedTourService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly analytics: OnboardingAnalyticsService,
  ) {}

  /** Idempotently seeds the global "hr_setup" tour definition. Safe to call repeatedly — mirrors ModuleChecklistService.ensureChecklistsForModules. */
  private async ensureHrSetupTourDefinition() {
    const existing = await this.db.query.guidedTours.findFirst({
      columns: { id: true },
      where: and(isNull(guidedTours.orgId), eq(guidedTours.tourKey, HR_SETUP_TOUR_KEY)),
    });
    if (existing) return;

    await this.db
      .insert(guidedTours)
      .values({ orgId: null, tourKey: HR_SETUP_TOUR_KEY, moduleKey: "hr", role: null, steps: [], isActive: true });
  }

  private tourOwnerPredicate(userId: string, membershipId: number | null | undefined) {
    if (membershipId != null)
      return or(
        eq(userTourProgress.membershipId, membershipId),
        and(isNull(userTourProgress.membershipId), eq(userTourProgress.userId, userId)),
      );
    return eq(userTourProgress.userId, userId);
  }

  async listToursForUser(orgId: string, userId: string, role?: string, membershipId?: number | null) {
    await this.ensureHrSetupTourDefinition();
    const tours = await this.db.query.guidedTours.findMany({
      limit: 100,
      where: and(
        or(eq(guidedTours.orgId, orgId), isNull(guidedTours.orgId)),
        eq(guidedTours.isActive, true),
      ),
    });
    const relevant = role ? tours.filter((t) => !t.role || t.role === role) : tours;

    const progressRows = await this.db.query.userTourProgress.findMany({
      limit: 100,
      where: and(eq(userTourProgress.orgId, orgId), this.tourOwnerPredicate(userId, membershipId)),
    });
    const progressByKey = new Map(progressRows.map((p) => [p.tourKey, p]));

    return relevant.map((tour) => ({
      ...tour,
      progress: progressByKey.get(tour.tourKey) ?? null,
    }));
  }

  private async getOrCreateProgress(orgId: string, userId: string, tourKey: string, membershipId?: number | null) {
    const existing = await this.db.query.userTourProgress.findFirst({
      where: and(
        eq(userTourProgress.orgId, orgId),
        this.tourOwnerPredicate(userId, membershipId),
        eq(userTourProgress.tourKey, tourKey),
      ),
    });
    if (existing) return existing;

    const [created] = await this.db
      .insert(userTourProgress)
      .values({ orgId, userId, membershipId: membershipId ?? null, tourKey, status: "in_progress", currentStep: 0 })
      .returning();
    return created;
  }

  async saveProgress(orgId: string, userId: string, tourKey: string, currentStep: number, membershipId?: number | null) {
    const progress = await this.getOrCreateProgress(orgId, userId, tourKey, membershipId);
    const [updated] = await this.db
      .update(userTourProgress)
      .set({ status: "in_progress", currentStep })
      .where(eq(userTourProgress.id, progress.id))
      .returning();
    return updated;
  }

  async completeTour(orgId: string, userId: string, tourKey: string, membershipId?: number | null) {
    const progress = await this.getOrCreateProgress(orgId, userId, tourKey, membershipId);
    const [updated] = await this.db
      .update(userTourProgress)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(userTourProgress.id, progress.id))
      .returning();
    await this.analytics.track(orgId, userId, "guided_tour_completed", { stepKey: tourKey });
    return updated;
  }

  async dismissTour(orgId: string, userId: string, tourKey: string, membershipId?: number | null) {
    const progress = await this.getOrCreateProgress(orgId, userId, tourKey, membershipId);
    const [updated] = await this.db
      .update(userTourProgress)
      .set({ status: "dismissed", dismissedAt: new Date() })
      .where(eq(userTourProgress.id, progress.id))
      .returning();
    await this.analytics.track(orgId, userId, "guided_tour_dismissed", { stepKey: tourKey });
    return updated;
  }
}
