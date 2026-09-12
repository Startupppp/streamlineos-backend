import { and, eq, inArray, sql } from "drizzle-orm";
import { subscriptions } from "../../db/schema";
import { appUrl } from "../email/app-url";
import { logger } from "../../common/logger/logger.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { RevenueAnalyticsService } from "../billing/core/revenue-analytics.service";
import { type RevenueEventInput } from "../billing/core/revenue-events";
import {
  PLAN_PRICES_PAISE,
  PLATFORM_PRICE_CURRENCY,
} from "../billing/core/plan-entitlements.constants";
import { type TenantTx } from "../../db/drizzle.types";
import { findOrgOwner, type PastDueDeps, type PastDueEntry } from "./cron-billing-past-due";

export interface SuspensionDeps extends PastDueDeps {
  readonly planLimits: PlanLimitsService;
  readonly revenue: RevenueAnalyticsService;
}

export async function suspendPastDue(
  deps: SuspensionDeps,
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

  await deps.planLimits.bust(orgId);
  const owner = await findOrgOwner(deps.db, orgId);

  const cancelled = entries.filter((entry) => claimed.has(entry.subscription.id));

  const suspensionChurn = cancelled.map((entry): RevenueEventInput => ({
    type: "churn",
    orgId,
    plan: entry.subscription.plan,
    mrr: PLAN_PRICES_PAISE[entry.subscription.plan],
    currency: PLATFORM_PRICE_CURRENCY,
    metadata: { subscriptionId: entry.subscription.id, source: "dunning-suspension" },
    dedupeKey: `dunning-suspension:${entry.subscription.id}`,
  }));
  await deps.revenue.emitMany(tx, suspensionChurn);

  if (owner)
    for (const entry of cancelled)
      await deps.dispatch
        .emit({
          orgId,
          eventKey: "billing.subscription.cancelled",
          targetUserIds: [owner.userId],
          title: "Subscription suspended due to non-payment",
          message:
            "Your subscription has been suspended because an outstanding payment could not be collected. Your data is safe. Please update your payment method to restore full access.",
          link: `${appUrl()}/settings/billing`,
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
