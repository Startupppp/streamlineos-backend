import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, lt, lte, or } from "drizzle-orm";
import {
  aiCreditTransactions,
  dunningAttempts,
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
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { RevenueAnalyticsService } from "../billing/core/revenue-analytics.service";
import { PLAN_PRICES_PAISE } from "../billing/core/plan-entitlements.constants";
import { type Plan } from "../billing/core/dto/billing.schemas";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { forEachOrg } from "../../common/tenant";

const REMINDER_DAYS = [7, 3, 1] as const;
const DUNNING_SCHEDULE_DAYS = [7, 3, 1] as const;
const SUSPENSION_DAY = 14;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

interface DunningMeta {
  pastDueAt?: string;
  lastFailedPaymentId?: string;
  suspendedForNonPayment?: boolean;
  suspendedAt?: string;
}

@Injectable()
export class CronBillingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
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
      for (const row of expiredRows) {
        await this.revenue.emit(tx, {
          type: "churn",
          orgId,
          plan: row.plan,
          mrr: 0,
          metadata: { subscriptionId: row.id, source: "trial-expiry" },
        });
      }

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
      const pastDueSubs = await this.db
        .select({
          id: subscriptions.id,
          orgId: subscriptions.orgId,
          plan: subscriptions.plan,
          metadata: subscriptions.metadata,
          updatedAt: subscriptions.updatedAt,
        })
        .from(subscriptions)
        .where(and(eq(subscriptions.orgId, orgId), eq(subscriptions.status, "PAST_DUE")));

      for (const sub of pastDueSubs) {
        const meta = (sub.metadata ?? {}) as DunningMeta;

        if (meta.suspendedForNonPayment) {
          skipped++;
          continue;
        }

        const pastDueAt = meta.pastDueAt ? new Date(meta.pastDueAt) : sub.updatedAt;
        const daysSincePastDue = Math.floor(
          (now.getTime() - pastDueAt.getTime()) / 86_400_000,
        );

        if (daysSincePastDue >= SUSPENSION_DAY) {
          await this.db
            .update(subscriptions)
            .set({
              status: "CANCELLED",
              updatedAt: now,
              metadata: {
                ...sub.metadata,
                suspendedForNonPayment: true,
                suspendedAt: now.toISOString(),
              },
            })
            .where(
              and(eq(subscriptions.id, sub.id), eq(subscriptions.status, "PAST_DUE")),
            );

          // The one churn event per paying customer lost, emitted with the cancellation.
          await this.revenue.emit(tx, {
            type: "churn",
            orgId: sub.orgId,
            plan: sub.plan,
            mrr: PLAN_PRICES_PAISE[sub.plan as Plan] ?? 0,
            metadata: { subscriptionId: sub.id, source: "dunning-suspension" },
          });

          await this.planLimits.bust(sub.orgId);

          const owner = await this.findOrgOwner(sub.orgId);
          if (owner) {
            await this.dispatch
              .emit({
                orgId: sub.orgId,
                eventKey: "billing.subscription.cancelled",
                targetUserIds: [owner.userId],
                title: "Subscription suspended due to non-payment",
                message:
                  "Your subscription has been suspended because an outstanding payment could not be collected. Your data is safe. Please update your payment method to restore full access.",
                link: `${appUrl()}/billing`,
                priority: "CRITICAL",
              })
              .catch((err: unknown) =>
                logger.warn("[billing-cron] suspension notification failed", { orgId: sub.orgId, err }),
              );
          }

          suspended++;
          continue;
        }

        let sentThisRun = false;
        for (const day of DUNNING_SCHEDULE_DAYS) {
          if (daysSincePastDue < day) continue;

          const milestone = `D+${day}`;
          const inserted = await this.db
            .insert(dunningAttempts)
            .values({
              orgId: sub.orgId,
              subscriptionId: sub.id,
              periodStart: pastDueAt,
              milestone,
            })
            .onConflictDoNothing()
            .returning({ id: dunningAttempts.id });

          if (inserted.length === 0) continue;

          const owner = await this.findOrgOwner(sub.orgId);
          if (owner) {
            const daysRemaining = SUSPENSION_DAY - daysSincePastDue;
            await this.dispatch
              .emit({
                orgId: sub.orgId,
                eventKey: "billing.payment.failed",
                targetUserIds: [owner.userId],
                title: `Payment overdue — action required (day ${day})`,
                message: `Your subscription payment remains outstanding. Please update your payment method within ${daysRemaining} day(s) to avoid suspension.`,
                link: `${appUrl()}/billing`,
                priority: "HIGH",
              })
              .catch((err: unknown) =>
                logger.warn("[billing-cron] dunning notification failed", { orgId: sub.orgId, day, err }),
              );
          }

          await this.db
            .update(dunningAttempts)
            .set({ status: "SENT", attemptedAt: now, updatedAt: now })
            .where(
              and(
                eq(dunningAttempts.orgId, sub.orgId),
                eq(dunningAttempts.subscriptionId, sub.id),
                eq(dunningAttempts.periodStart, pastDueAt),
                eq(dunningAttempts.milestone, milestone),
              ),
            );

          notified++;
          sentThisRun = true;
          break;
        }

        if (!sentThisRun) {
          skipped++;
        }
      }
    });

    return { notified, suspended, skipped };
  }

  private async findOrgOwner(orgId: string): Promise<{ userId: string; email: string } | null> {
    const [owner] = await this.db
      .select({ userId: organizationMembers.userId, email: users.email })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.isOwner, true),
          eq(users.isActive, true),
        ),
      )
      .limit(1);
    return owner ?? null;
  }

  private async hasSameDayTopUpIst(orgId: string, packId: number): Promise<boolean> {
    const now = new Date();
    const istMirror = new Date(now.getTime() + IST_OFFSET_MS);

    // IST day expressed as UTC timestamps (IST +05:30 means every IST day starts
    // 5h30m before UTC midnight, so it always spans exactly 2 UTC calendar dates).
    const istDayStartUtc = new Date(
      Date.UTC(istMirror.getUTCFullYear(), istMirror.getUTCMonth(), istMirror.getUTCDate()) -
        IST_OFFSET_MS,
    );
    const istDayEndUtc = new Date(istDayStartUtc.getTime() + 86_400_000);

    // Build the UTC-date strings for both UTC calendar dates within this IST day.
    // utcDateA = the UTC date at the start of the IST window (always istMirror.date - 1 in UTC)
    // utcDateB = the UTC date for the remaining portion (adding 6h always crosses to the next UTC date)
    const fmtDate = (d: Date): string =>
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const utcDateB = new Date(istDayStartUtc.getTime() + 6 * 60 * 60 * 1000);

    // Manual purchase referenceId = String(packId); automatic = `auto-<packId>-<UTC date>`.
    // We check both UTC dates that fall in the IST window to catch purchases that occurred
    // near UTC midnight on either side (the bug: same IST day, two UTC dates → two top-ups).
    const [row] = await this.db
      .select({ id: aiCreditTransactions.id })
      .from(aiCreditTransactions)
      .where(
        and(
          eq(aiCreditTransactions.orgId, orgId),
          eq(aiCreditTransactions.type, "PURCHASE"),
          gte(aiCreditTransactions.createdAt, istDayStartUtc),
          lt(aiCreditTransactions.createdAt, istDayEndUtc),
          or(
            eq(aiCreditTransactions.referenceId, String(packId)),
            eq(aiCreditTransactions.referenceId, `auto-${packId}-${fmtDate(istDayStartUtc)}`),
            eq(aiCreditTransactions.referenceId, `auto-${packId}-${fmtDate(utcDateB)}`),
          ),
        ),
      )
      .limit(1);
    return !!row;
  }
}
