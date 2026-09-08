import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
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
import { BillingService } from "../billing/core/billing.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { RevenueAnalyticsService } from "../billing/core/revenue-analytics.service";
import { type RevenueEventInput } from "../billing/core/revenue-events";
import { PLAN_PRICES_PAISE, PLATFORM_PRICE_CURRENCY } from "../billing/core/plan-entitlements.constants";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { forEachOrg, type TenantTx } from "../../common/tenant";

const REMINDER_DAYS = [7, 3, 1] as const;
const DUNNING_SCHEDULE_DAYS = [7, 3, 1] as const;
const SUSPENSION_DAY = 14;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const REDRIVE_MIN_AGE_MS = 5 * 60 * 1000;
const REDRIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REDRIVE_BATCH = 100;

type PastDueSubscription = Pick<
  typeof subscriptions.$inferSelect,
  "id" | "orgId" | "plan" | "metadata" | "updatedAt"
>;

interface PastDueEntry {
  subscription: PastDueSubscription;
  pastDueAt: Date;
  daysSincePastDue: number;
}

interface PlannedAttempt {
  subscriptionId: number;
  pastDueAt: Date;
  milestone: string;
  day: number;
  daysRemaining: number;
}

const attemptKey = (subscriptionId: number, pastDueAt: Date, milestone: string): string =>
  `${subscriptionId}|${pastDueAt.getTime()}|${milestone}`;

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

      // Every reminder window answered by one read of the org's live trial ends,
      // rather than one bounded-but-repeated query per reminder day.
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

      for (const days of REMINDER_DAYS) {
        const windowStart = new Date(now);
        windowStart.setDate(windowStart.getDate() + days);
        windowStart.setHours(0, 0, 0, 0);
        const windowEnd = new Date(windowStart);
        windowEnd.setHours(23, 59, 59, 999);

        const soonExpiring = trialEnds.some(
          (row) =>
            row.trialEndsAt !== null &&
            row.trialEndsAt >= windowStart &&
            row.trialEndsAt <= windowEnd,
        );

        if (!soonExpiring) continue;

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

      const toSuspend: PastDueEntry[] = [];
      const toRemind: PastDueEntry[] = [];

      for (const subscription of pastDueSubs) {
        const metadata = subscription.metadata ?? {};
        if (metadata["suspendedForNonPayment"] === true) {
          skipped++;
          continue;
        }

        const recordedPastDueAt = metadata["pastDueAt"];
        const pastDueAt =
          typeof recordedPastDueAt === "string"
            ? new Date(recordedPastDueAt)
            : subscription.updatedAt;
        const daysSincePastDue = Math.floor((now.getTime() - pastDueAt.getTime()) / 86_400_000);
        const entry: PastDueEntry = { subscription, pastDueAt, daysSincePastDue };

        if (daysSincePastDue >= SUSPENSION_DAY) toSuspend.push(entry);
        else toRemind.push(entry);
      }

      const suspensions = await this.suspendPastDue(tx, orgId, toSuspend, now);
      suspended += suspensions.suspended;
      skipped += suspensions.skipped;

      const reminders = await this.remindPastDue(tx, orgId, toRemind, now);
      notified += reminders.notified;
      skipped += reminders.skipped;
    });

    return { notified, suspended, skipped };
  }

  /**
   * Every subscription past the suspension day, cancelled by one statement.
   *
   * The claim stays exactly as conditional as it was per row — `status =
   * 'PAST_DUE'` is still in the predicate, so a sweep that lost the race flips
   * nothing and the row is simply absent from `RETURNING`. The metadata patch is
   * identical for every row, so it is merged server-side with `||` rather than
   * read-modify-written per subscription, which also stops a concurrent metadata
   * write being clobbered.
   */
  private async suspendPastDue(
    tx: TenantTx,
    orgId: string,
    entries: readonly PastDueEntry[],
    now: Date,
  ): Promise<{ suspended: number; skipped: number }> {
    if (entries.length === 0) return { suspended: 0, skipped: 0 };

    const ids = entries.map((entry) => entry.subscription.id);
    const patch = JSON.stringify({
      suspendedForNonPayment: true,
      suspendedAt: now.toISOString(),
    });

    const flipped = await tx
      .update(subscriptions)
      .set({
        status: "CANCELLED",
        updatedAt: now,
        metadata: sql`COALESCE(${subscriptions.metadata}, '{}'::jsonb) || ${patch}::jsonb`,
      })
      .where(
        and(
          eq(subscriptions.orgId, orgId),
          eq(subscriptions.status, "PAST_DUE"),
          inArray(subscriptions.id, ids),
        ),
      )
      .returning({ id: subscriptions.id });

    const claimed = new Set(flipped.map((row) => row.id));
    const skipped = entries.length - claimed.size;
    if (claimed.size === 0) return { suspended: 0, skipped };

    await this.planLimits.bust(orgId);
    const owner = await this.findOrgOwner(orgId);

    const cancelled = entries.filter((entry) => claimed.has(entry.subscription.id));

    // The one churn event per paying customer lost, committed with the cancellation in the
    // sweep's own transaction. The dedupeKey names the movement, so a re-run of this sweep
    // conflicts on the outbox event id instead of committing a second churn row.
    const suspensionChurn = cancelled.map((entry): RevenueEventInput => ({
      type: "churn",
      orgId,
      plan: entry.subscription.plan,
      mrr: PLAN_PRICES_PAISE[entry.subscription.plan],
      currency: PLATFORM_PRICE_CURRENCY,
      metadata: { subscriptionId: entry.subscription.id, source: "dunning-suspension" },
      dedupeKey: `dunning-suspension:${entry.subscription.id}`,
    }));
    await this.revenue.emitMany(tx, suspensionChurn);

    if (owner)
      for (const entry of cancelled)
        await this.dispatch
          .emit({
            orgId,
            eventKey: "billing.subscription.cancelled",
            targetUserIds: [owner.userId],
            title: "Subscription suspended due to non-payment",
            message:
              "Your subscription has been suspended because an outstanding payment could not be collected. Your data is safe. Please update your payment method to restore full access.",
            link: `${appUrl()}/billing`,
            priority: "CRITICAL",
          })
          .catch((err: unknown) =>
            logger.warn("[billing-cron] suspension notification failed", {
              orgId,
              subscriptionId: entry.subscription.id,
              err,
            }),
          );

    return { suspended: claimed.size, skipped };
  }

  /**
   * The next unsent milestone for every still-recoverable subscription.
   *
   * The unique index on `(org, subscription, period, milestone)` used to be
   * consulted by attempting an insert per milestone per subscription. The
   * milestones already recorded are now read once for the whole batch, the
   * remaining ones claimed by a single `onConflictDoNothing` insert — which is
   * still the authority, so a sweep racing this one notifies nobody twice — and
   * marked `SENT` by one update.
   */
  private async remindPastDue(
    tx: TenantTx,
    orgId: string,
    entries: readonly PastDueEntry[],
    now: Date,
  ): Promise<{ notified: number; skipped: number }> {
    if (entries.length === 0) return { notified: 0, skipped: 0 };

    const existing = await tx
      .select({
        subscriptionId: dunningAttempts.subscriptionId,
        periodStart: dunningAttempts.periodStart,
        milestone: dunningAttempts.milestone,
      })
      .from(dunningAttempts)
      .where(
        and(
          eq(dunningAttempts.orgId, orgId),
          inArray(
            dunningAttempts.subscriptionId,
            entries.map((entry) => entry.subscription.id),
          ),
        ),
      );

    const recorded = new Set(
      existing.map((row) => attemptKey(row.subscriptionId, row.periodStart, row.milestone)),
    );

    const planned: PlannedAttempt[] = [];
    for (const entry of entries) {
      for (const day of DUNNING_SCHEDULE_DAYS) {
        if (entry.daysSincePastDue < day) continue;
        const milestone = `D+${day}`;
        if (recorded.has(attemptKey(entry.subscription.id, entry.pastDueAt, milestone))) continue;
        planned.push({
          subscriptionId: entry.subscription.id,
          pastDueAt: entry.pastDueAt,
          milestone,
          day,
          daysRemaining: SUSPENSION_DAY - entry.daysSincePastDue,
        });
        break;
      }
    }

    if (planned.length === 0) return { notified: 0, skipped: entries.length };

    const attemptRows = planned.map((attempt) => ({
      orgId,
      subscriptionId: attempt.subscriptionId,
      periodStart: attempt.pastDueAt,
      milestone: attempt.milestone,
    }));

    const inserted = await tx
      .insert(dunningAttempts)
      .values(attemptRows)
      .onConflictDoNothing()
      .returning({
        id: dunningAttempts.id,
        subscriptionId: dunningAttempts.subscriptionId,
        milestone: dunningAttempts.milestone,
      });

    const claimedIds = new Map(
      inserted.map((row) => [`${row.subscriptionId}|${row.milestone}`, row.id]),
    );
    const sending = planned.filter((attempt) =>
      claimedIds.has(`${attempt.subscriptionId}|${attempt.milestone}`),
    );

    const skipped = entries.length - sending.length;
    if (sending.length === 0) return { notified: 0, skipped };

    const owner = await this.findOrgOwner(orgId);
    if (owner) {
      for (const attempt of sending) {
        await this.dispatch
          .emit({
            orgId,
            eventKey: "billing.payment.failed",
            targetUserIds: [owner.userId],
            title: `Payment overdue — action required (day ${attempt.day})`,
            message: `Your subscription payment remains outstanding. Please update your payment method within ${attempt.daysRemaining} day(s) to avoid suspension.`,
            link: `${appUrl()}/billing`,
            priority: "HIGH",
          })
          .catch((err: unknown) =>
            logger.warn("[billing-cron] dunning notification failed", {
              orgId,
              day: attempt.day,
              err,
            }),
          );
      }
    }

    await tx
      .update(dunningAttempts)
      .set({ status: "SENT", attemptedAt: now, updatedAt: now })
      .where(
        and(
          eq(dunningAttempts.orgId, orgId),
          inArray(dunningAttempts.id, [...claimedIds.values()]),
        ),
      );

    return { notified: sending.length, skipped };
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
