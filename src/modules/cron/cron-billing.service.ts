import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, lt, lte } from "drizzle-orm";
import { subscriptions, organizations, organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";
import { appUrl } from "../email/app-url";
import { logger } from "../../common/logger/logger.service";
import { AiCreditsService } from "../billing/ai-credits.service";

const REMINDER_DAYS = [7, 3, 1] as const;

@Injectable()
export class CronBillingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
    private readonly aiCredits: AiCreditsService,
  ) {}

  async processTrialExpiry(): Promise<{ expired: number; reminded: number }> {
    const now = new Date();
    let expired = 0;
    let reminded = 0;

    const expiredTrials = await this.db
      .select({ id: subscriptions.id, orgId: subscriptions.orgId })
      .from(subscriptions)
      .where(and(eq(subscriptions.status, "TRIAL"), lt(subscriptions.trialEndsAt, now)))
      .limit(200);

    for (const trial of expiredTrials) {
      try {
        await this.db
          .update(subscriptions)
          .set({ status: "EXPIRED", updatedAt: now })
          .where(eq(subscriptions.id, trial.id));
        expired++;
      } catch (err) {
        logger.error("[billing-cron] failed to expire trial", { id: trial.id, err });
      }
    }

    for (const days of REMINDER_DAYS) {
      const windowStart = new Date(now);
      windowStart.setDate(windowStart.getDate() + days);
      windowStart.setHours(0, 0, 0, 0);
      const windowEnd = new Date(windowStart);
      windowEnd.setHours(23, 59, 59, 999);

      const soonExpiring = await this.db
        .select({ orgId: subscriptions.orgId })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.status, "TRIAL"),
            gte(subscriptions.trialEndsAt, windowStart),
            lte(subscriptions.trialEndsAt, windowEnd),
          ),
        )
        .limit(200);

      for (const trial of soonExpiring) {
        try {
          const owner = await this.findOrgOwner(trial.orgId);
          if (!owner) continue;
          await this.email
            .sendTrialReminderEmail(owner.email, owner.orgName, days, `${appUrl}/settings/subscription`)
            .catch((err: unknown) => logger.warn("[billing-cron] email send failed", { err }));
          reminded++;
        } catch (err) {
          logger.warn("[billing-cron] reminder failed", { orgId: trial.orgId, days, err });
        }
      }
    }

    return { expired, reminded };
  }

  async processMonthlyPlanGrants(): Promise<{ granted: number; skipped: number }> {
    const activeSubscriptions = await this.db
      .select({ orgId: subscriptions.orgId, plan: subscriptions.plan })
      .from(subscriptions)
      .where(eq(subscriptions.status, "ACTIVE"))
      .limit(500);

    let granted = 0;
    let skipped = 0;

    if (activeSubscriptions.length === 0) return { granted, skipped };

    const allOrgIds = activeSubscriptions.map((s) => s.orgId);
    const alreadyGrantedSet = await this.aiCredits.getMonthlyGrantedOrgIds(allOrgIds);

    const now = new Date();
    const monthRef = `monthly-${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

    for (const sub of activeSubscriptions) {
      if (alreadyGrantedSet.has(sub.orgId)) {
        skipped++;
        continue;
      }
      try {
        await this.aiCredits.grantPlanCredits(sub.orgId, sub.plan, undefined, `${sub.plan}-${monthRef}`);
        granted++;
      } catch (err) {
        logger.error("[billing-cron] monthly plan grant failed", { orgId: sub.orgId, err });
      }
    }

    return { granted, skipped };
  }

  async processAutoTopUps(): Promise<{ topped: number; skipped: number; failed: number }> {
    const wallets = await this.aiCredits.getWalletsEligibleForAutoTopUp();

    let topped = 0;
    let skipped = 0;
    let failed = 0;

    for (const wallet of wallets) {
      if (wallet.autoTopUpPackId === null) {
        skipped++;
        continue;
      }
      try {
        const alreadyToppedToday = await this.aiCredits.hasSameDayPurchaseForPack(
          wallet.orgId,
          wallet.autoTopUpPackId,
        );
        if (alreadyToppedToday) {
          skipped++;
          continue;
        }
        await this.aiCredits.purchaseCreditsDirectly(
          wallet.orgId,
          null,
          wallet.autoTopUpPackId,
          true,
        );
        topped++;
      } catch (err) {
        logger.error("[billing-cron] auto top-up failed", { orgId: wallet.orgId, err });
        failed++;
      }
    }

    return { topped, skipped, failed };
  }

  private async findOrgOwner(orgId: string): Promise<{ email: string; orgName: string } | null> {
    const rows = await this.db
      .select({ email: users.email, orgName: organizations.name })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .innerJoin(organizations, eq(organizationMembers.orgId, organizations.id))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.isOwner, true),
          eq(users.isActive, true),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row?.email) return null;
    return { email: row.email, orgName: row.orgName ?? "Your Organization" };
  }
}
