import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, isNotNull, lt, or } from "drizzle-orm";
import {
  aiCreditTransactions,
  organizationMembers,
  organizations,
  subscriptions,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { appUrl } from "../email/app-url";
import { logger } from "../../common/logger/logger.service";
import { AiCreditsService } from "../billing/core/ai-credits.service";
import { BillingService } from "../billing/core/billing.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { RevenueAnalyticsService } from "../billing/core/revenue-analytics.service";
import { type RevenueEventInput } from "../billing/core/revenue-events";
import { PLATFORM_PRICE_CURRENCY } from "../billing/core/plan-entitlements.constants";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { forEachOrg } from "../../common/tenant";
import { triagePastDue, type PastDueSubscription } from "./cron-billing-past-due";
import { suspendPastDue } from "./cron-billing-suspension";
import { remindPastDue } from "./cron-billing-dunning";
import { istTopUpWindow } from "./cron-billing-top-up-window";
import { dueReminderDays } from "./cron-billing-trial-reminders";

const REDRIVE_MIN_AGE_MS = 5 * 60 * 1000;
const REDRIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REDRIVE_BATCH = 100;

@Injectable()
export class CronBillingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly billing: BillingService,
    private readonly aiCredits: AiCreditsService,
    private readonly planLimits: PlanLimitsService,
    private readonly revenue: RevenueAnalyticsService,
    private readonly dispatch: NotificationDispatchService,
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
        .returning({ id: subscriptions.id, plan: subscriptions.plan });
      expired += expiredRows.length;

      // A trial that lapses is a lost customer but no lost MRR — it never contributed any.
      const lapsedChurn = expiredRows.map((row): RevenueEventInput => ({
        type: "churn",
        orgId,
        plan: row.plan,
        mrr: 0,
        currency: PLATFORM_PRICE_CURRENCY,
        metadata: { subscriptionId: row.id, source: "trial-expiry" },
      }));
      if (lapsedChurn.length > 0) await this.revenue.emitMany(tx, lapsedChurn);

      const ownerRows = await tx
        .select({ userId: users.id, email: users.email, orgName: organizations.name })
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
      if (!owner?.email || !owner.userId) return;

      const trialEnds = await tx
        .select({ trialEndsAt: subscriptions.trialEndsAt })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.orgId, orgId),
            eq(subscriptions.status, "TRIAL"),
            isNotNull(subscriptions.trialEndsAt),
          ),
        );

      for (const days of dueReminderDays(trialEnds, now)) {
        await this.dispatch
          .emit({
            orgId,
            eventKey: "billing.trial.expiring",
            targetUserIds: [owner.userId],
            title: `Your trial ends in ${days} day${days === 1 ? "" : "s"}`,
            message: `Your ${owner.orgName ?? "organization"} trial is ending soon. Update your plan to keep access to your workspace.`,
            link: `${appUrl()}/billing?tab=plan`,
            dedupeKey: `trial-expiry:${now.toISOString().slice(0, 10)}:${days}`,
          })
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

  /**
   * `sweepExpiredReservations` iterates every organisation itself, under
   * `forEachOrg("sweep:expired-ai-reservations")`. Wrapping it in a second `forEachOrg`
   * ran the whole cross-tenant sweep once per organisation — 64 tenant blocks and 64
   * enumeration queries for the eight-tenant fixture, of which 56 found nothing because
   * the first pass had already drained them. Each inner `withTenant` also reset
   * `app.organization_id` inside the outer transaction, so the outer tenant's GUC was
   * left pointing at whichever organisation the inner loop had reached last.
   */
  async sweepAiReservations(): Promise<{ released: number }> {
    return { released: await this.aiCredits.sweepExpiredReservations() };
  }

  /**
   * A provider gives up retrying long before a multi-hour outage ends, leaving a paid-for grant
   * recorded but never applied. Events older than `MAX_AGE` are left for an operator instead of
   * being retried forever, so this sweep cannot loop on a permanently failing event.
   */
  async redriveStuckProviderEvents(): Promise<{ attempted: number; recovered: number; failed: number }> {
    let attempted = 0;
    let recovered = 0;
    let failed = 0;

    await forEachOrg(this.db, "billing-provider-event-redrive", async (_tx, orgId) => {
      const result = await this.billing.redriveStuckProviderEvents(orgId, {
        minAgeMs: REDRIVE_MIN_AGE_MS,
        maxAgeMs: REDRIVE_MAX_AGE_MS,
        limit: REDRIVE_BATCH,
      });
      attempted += result.attempted;
      recovered += result.recovered;
      failed += result.failed;
    });

    return { attempted, recovered, failed };
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
          const alreadyToppedToday = await this.hasSameDayTopUpIst(
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

  async processDunning(): Promise<{ notified: number; suspended: number; skipped: number }> {
    const now = new Date();
    let notified = 0;
    let suspended = 0;
    let skipped = 0;

    await forEachOrg(this.db, "billing-dunning", async (tx, orgId) => {
      const pastDueSubs: PastDueSubscription[] = await tx
        .select({
          id: subscriptions.id,
          orgId: subscriptions.orgId,
          plan: subscriptions.plan,
          metadata: subscriptions.metadata,
          updatedAt: subscriptions.updatedAt,
        })
        .from(subscriptions)
        .where(and(eq(subscriptions.orgId, orgId), eq(subscriptions.status, "PAST_DUE")));

      if (pastDueSubs.length === 0) return;

      const triage = triagePastDue(pastDueSubs, now);
      skipped += triage.alreadySuspended;

      const deps = {
        db: this.db,
        dispatch: this.dispatch,
        planLimits: this.planLimits,
        revenue: this.revenue,
      };

      const suspensions = await suspendPastDue(deps, tx, orgId, triage.toSuspend, now);
      suspended += suspensions.suspended;
      skipped += suspensions.skipped;

      const reminders = await remindPastDue(deps, tx, orgId, triage.toRemind, now);
      notified += reminders.notified;
      skipped += reminders.skipped;
    });

    return { notified, suspended, skipped };
  }

  private async hasSameDayTopUpIst(orgId: string, packId: number): Promise<boolean> {
    const window = istTopUpWindow(new Date(), packId);

    const [row] = await this.db
      .select({ id: aiCreditTransactions.id })
      .from(aiCreditTransactions)
      .where(
        and(
          eq(aiCreditTransactions.orgId, orgId),
          eq(aiCreditTransactions.type, "PURCHASE"),
          gte(aiCreditTransactions.createdAt, window.startUtc),
          lt(aiCreditTransactions.createdAt, window.endUtc),
          or(...window.referenceIds.map((ref) => eq(aiCreditTransactions.referenceId, ref))),
        ),
      )
      .limit(1);
    return !!row;
  }
}
