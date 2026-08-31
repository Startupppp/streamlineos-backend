import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { organizationMembers } from "../../../db/schema";
import { OnboardingAnalyticsService } from "../../hr/onboarding/flow/onboarding-analytics.service";
import { NotificationsService } from "../../notifications/notifications.service";

@Injectable()
export class PaymentAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly analytics: OnboardingAnalyticsService,
    private readonly notifications: NotificationsService,
  ) {}

  track(orgId: string, userId: string | null, eventType: string, opts: { moduleKey?: string; metadata?: Record<string, unknown> } = {}) {
    return this.analytics.track(orgId, userId, eventType, { source: "payments", moduleKey: opts.moduleKey ?? "PAYMENTS", metadata: opts.metadata });
  }

  private async resolveOwnerUserId(orgId: string): Promise<string | null> {
    const owner = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.isOwner, true)),
    });
    return owner?.userId ?? null;
  }

  async notifyOwner(
    orgId: string,
    input: { title: string; message: string; type?: "INFO" | "SUCCESS" | "WARNING" | "ERROR"; priority?: "LOW" | "NORMAL" | "HIGH" | "CRITICAL"; link?: string },
  ) {
    const ownerUserId = await this.resolveOwnerUserId(orgId);
    if (!ownerUserId) return;
    await this.notifications.create({
      orgId,
      userId: ownerUserId,
      category: "BILLING",
      sourceModule: "payments",
      type: input.type ?? "INFO",
      priority: input.priority ?? "NORMAL",
      title: input.title,
      message: input.message,
      link: input.link ?? "/accounting/settings/payment-providers",
    });
  }
}
