import { z } from "zod";
import { PLAN_PRICES_PAISE } from "./plan-entitlements.constants";
import type { Plan } from "./dto/billing.schemas";

export const REVENUE_EVENT_TYPE = "billing.revenue-event";

export const revenueEventTypes = [
  "new_subscription",
  "upgrade",
  "downgrade",
  "churn",
  "reactivation",
  "addon_purchase",
  "refund",
] as const;

export type RevenueEventType = (typeof revenueEventTypes)[number];

export interface RevenueEventInput {
  type: RevenueEventType;
  orgId: string;
  plan?: string;
  previousPlan?: string;
  // Monthly recurring movement in integer MINOR UNITS of `currency`; a magnitude, the type
  // carries the sign.
  mrr: number;
  amount?: number;
  /**
   * ISO-4217 code naming the denomination of `mrr` and `amount`. Required, because an integer
   * count of minor units means nothing without it: platform plan movements are paise of
   * PLATFORM_PRICE_CURRENCY, while a provider webhook reports the payment's own currency, and
   * the two used to land in the same column indistinguishable from one another.
   */
  currency: string;
  metadata?: Record<string, unknown>;
  /**
   * Identifies the real-world movement this event reports, so a producer that runs twice for one
   * movement emits the same `event_id` twice and the second insert conflicts instead of adding a
   * second row. Omit it only where the movement genuinely has no stable identity.
   */
  dedupeKey?: string;
}

export const revenueEventPayloadSchema = z.object({
  type: z.enum(revenueEventTypes),
  orgId: z.string().min(1),
  plan: z.string().nullable().default(null),
  previousPlan: z.string().nullable().default(null),
  mrr: z.number().int(),
  amount: z.number().int().nullable().default(null),
  // Nullable with a null default on purpose: events emitted before the column existed are already
  // sitting in the outbox, and a required field here would make the consumer mark each of them
  // FAILED on the first read instead of writing the row it was emitted for.
  currency: z.string().length(3).nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).nullable().default(null),
});

type RevenueEventPayload = z.infer<typeof revenueEventPayloadSchema>;

export interface PlanChange {
  type: RevenueEventType;
  mrr: number;
  previousPlan?: string;
}

// The one place that decides which revenue event a paid activation is; a renewal moves no MRR.
export function classifyPlanChange(
  existing: { plan: string; status: string } | null,
  nextPlan: Plan,
): PlanChange | null {
  const nextPrice = PLAN_PRICES_PAISE[nextPlan];
  if (!existing) return { type: "new_subscription", mrr: nextPrice };
  if (existing.status === "TRIAL") return { type: "new_subscription", mrr: nextPrice };

  if (existing.status !== "ACTIVE")
    return { type: "reactivation", mrr: nextPrice, previousPlan: existing.plan };

  if (existing.plan === nextPlan) return null;

  const previousPrice = PLAN_PRICES_PAISE[existing.plan as Plan] ?? 0;
  const delta = nextPrice - previousPrice;
  if (delta === 0) return null;
  return {
    type: delta > 0 ? "upgrade" : "downgrade",
    mrr: Math.abs(delta),
    previousPlan: existing.plan,
  };
}
