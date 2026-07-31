import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, lt, lte } from "drizzle-orm";
import { subscriptions, organizations, organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";
import { appUrl } from "../email/app-url";
import { logger } from "../../common/logger/logger.service";
import { AiCreditsService } from "../billing/core/ai-credits.service";
import { forEachOrg } from "../../common/tenant";

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

    await forEachOrg(this.db, "billing-trial-expiry", async (tx, orgId) => {
      const expiredRows = await tx
        .update(subscriptions)
        .set({ status: "EXPIRED", updatedAt: now })
        .where(
          and(
            eq(subscriptions.orgId, orgId),
            eq(subscriptions.status, "TRIAL"),
            lt(subscriptions.trialEndsAt, now),
          ),
        )
        .returning({ id: subscriptions.id });
      expired += expiredRows.length;

      const ownerRows = await tx
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
      const owner = ownerRows[0];
      if (!owner?.email) return;

      for (const days of REMINDER_DAYS) {
        const windowStart = new Date(now);
        windowStart.setDate(windowStart.getDate() + days);
        windowStart.setHours(0, 0, 0, 0);
        const windowEnd = new Date(windowStart);
        windowEnd.setHours(23, 59, 59, 999);

        const soonExpiring = await tx
          .select({ id: subscriptions.id })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.orgId, orgId),
              eq(subscriptions.status, "TRIAL"),
              gte(subscriptions.trialEndsAt, windowStart),
              lte(subscriptions.trialEndsAt, windowEnd),
            ),
          )
          .limit(1);

        if (soonExpiring.length === 0) continue;

        await this.email
          .sendTrialReminderEmail(owner.email, owner.orgName ?? "Your Organization", days, `${appUrl}/settings/subscription`)
          .catch((err: unknown) => logger.warn("[billing-cron] email send failed", { err }));
        reminded++;
      }
    });

    return { expired, reminded };
  }

  async processMonthlyPlanGrants(): Promise<{ granted: number; skipped: number }> {
    let granted = 0;
    let skipped = 0;

    const now = new Date();
    const monthRef = `monthly-${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

    await forEachOrg(this.db, "billing-monthly-grants", async (tx, orgId) => {
      const rows = await tx
        .select({ plan: subscriptions.plan })
        .from(subscriptions)
        .where(and(eq(subscriptions.orgId, orgId), eq(subscriptions.status, "ACTIVE")))
        .limit(1);

      const sub = rows[0];
      if (!sub) {
        skipped++;
        return;
      }

      const alreadyGrantedSet = await this.aiCredits.getMonthlyGrantedOrgIds([orgId]);
      if (alreadyGrantedSet.has(orgId)) {
        skipped++;
        return;
      }

      await this.aiCredits.grantPlanCredits(orgId, sub.plan, undefined, `${sub.plan}-${monthRef}`);
      granted++;
    });

    return { granted, skipped };
  }

  async sweepAiReservations(): Promise<{ released: number }> {
    let released = 0;
    await forEachOrg(this.db, "billing-ai-sweep-reservations", async (_tx, _orgId) => {
      released += await this.aiCredits.sweepExpiredReservations();
    });
    return { released };
  }

  async processAutoTopUps(): Promise<{ topped: number; skipped: number; failed: number }> {
    let topped = 0;
    let skipped = 0;
    let failed = 0;

    await forEachOrg(this.db, "billing-auto-top-ups", async (_tx, _orgId) => {
      const wallets = await this.aiCredits.getWalletsEligibleForAutoTopUp();

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
    });

    return { topped, skipped, failed };
  }
}
