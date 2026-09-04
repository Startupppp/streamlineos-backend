import {
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { subscriptionPayments, subscriptions } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { ExternalEffectLedger } from "../../../common/outbox/external-effect-ledger";
import { PaymentProviderResolver } from "../payments/payment-provider-resolver.service";
import { AiCreditsService } from "./ai-credits.service";
import { BillingCoupons } from "./billing-coupons";
import { type BillingCycle, type ConfirmCheckoutInput, type Plan } from "./dto/billing.schemas";
import { PlanLimitsService } from "./plan-limits.service";
import {
  ANNUAL_DISCOUNT_PCT,
  PLAN_PRICES_PAISE,
  PLATFORM_PRICE_CURRENCY,
} from "./plan-entitlements.constants";
import { ProrationLedgerService } from "./proration-ledger.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { classifyPlanChange } from "./revenue-events";
import { VersionedCatalogService } from "./versioned-catalog.service";
import { applyDiscount } from "./coupon-pricing";
import {
  grantPlanCredits,
  recordCouponRedemption,
  recordProrationForPlanChange,
} from "./billing-activation-recorders";
import { isUniqueViolation, isUniqueViolationOn } from "../../../common/db/postgres-error";

export interface BillingPaymentActivationDeps {
  db: Db;
  audit: AuditService;
  aiCredits: AiCreditsService;
  planLimits: PlanLimitsService;
  prorationLedger: ProrationLedgerService;
  catalog: VersionedCatalogService;
  revenueAnalytics: RevenueAnalyticsService;
  providers: PaymentProviderResolver;
  externalEffectLedger: ExternalEffectLedger;
}

export class BillingPaymentActivation {
  private readonly couponAdmin: BillingCoupons;
  private readonly logger = new Logger(BillingPaymentActivation.name);

  constructor(private readonly deps: BillingPaymentActivationDeps) {
    this.couponAdmin = new BillingCoupons(deps.db);
  }

  async createOrder(
    orgId: string,
    userId: string,
    plan: Plan,
    billingCycle: BillingCycle = "monthly",
    couponId?: number,
  ) {
    const adapter = await this.deps.providers.resolveConfigured(orgId);
    if (adapter === undefined || !adapter.isReady()) {
      throw new ServiceUnavailableException("Payment gateway not configured. Contact support.");
    }
    if (!PLAN_PRICES_PAISE[plan]) throw new BadRequestException("Invalid plan");

    const price = await this.billablePrice(plan, billingCycle);
    const baseAmount = price.amount;
    let amount = baseAmount;
    let couponDiscountAmount = 0;
    if (couponId) {
      const evaluation = await this.couponAdmin.evaluate(couponId, orgId, plan, baseAmount);
      if (!evaluation.eligible) throw new BadRequestException(evaluation.reason);
      couponDiscountAmount = evaluation.discountAmount;
      amount = applyDiscount(baseAmount, couponDiscountAmount);
    }

    const { providerOrderId } = await adapter.createOrder({
      amount: String(amount),
      currency: price.currency,
      receipt: `sub_${orgId.slice(-8)}_${Date.now().toString().slice(-8)}`,
      notes: { orgId, plan, userId, billingCycle },
    });
    return {
      orderId: providerOrderId,
      amount,
      currency: price.currency,
      keyId: adapter.publicKeyId(),
      plan,
      billingCycle,
      discountAmount: couponDiscountAmount,
    };
  }

  async verifyAndActivate(orgId: string, userId: string, input: ConfirmCheckoutInput) {
    const adapter = await this.deps.providers.resolveConfigured(orgId);
    if (adapter === undefined || !adapter.isReady()) {
      throw new ServiceUnavailableException("Payment gateway not configured. Contact support.");
    }
    const valid = adapter.verifyPaymentSignature({
      orderId: input.orderId,
      paymentId: input.paymentId,
      signature: input.signature,
    });
    if (!valid) throw new BadRequestException("Payment verification failed: invalid signature");

    const billingCycle = input.billingCycle ?? "monthly";
    const price = await this.billablePrice(input.plan, billingCycle);
    const amount = price.amount;
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + (billingCycle === "annual" ? 12 : 1));

    try {
      await this.deps.db.transaction(async (tx) => {
        const existing = await tx.query.subscriptions.findFirst({ where: eq(subscriptions.orgId, orgId) });
        const revenue = classifyPlanChange(
          existing ? { plan: existing.plan, status: existing.status } : null,
          input.plan,
        );
        let subscriptionId: number;
        if (existing) {
          await recordProrationForPlanChange(this.deps, this.logger, tx, orgId, existing, input.plan, now);
          await tx.update(subscriptions).set({
            plan: input.plan,
            status: "ACTIVE",
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            updatedAt: now,
          }).where(eq(subscriptions.id, existing.id));
          subscriptionId = existing.id;
        } else {
          const [created] = await tx.insert(subscriptions).values({
            orgId,
            plan: input.plan,
            status: "ACTIVE",
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
          }).returning({ id: subscriptions.id });
          subscriptionId = created.id;
        }

        await tx.insert(subscriptionPayments).values({
          orgId,
          subscriptionId,
          razorpayPaymentId: input.paymentId,
          razorpayOrderId: input.orderId,
          amountPaise: amount,
          currency: price.currency,
          status: "captured",
          paidAt: now,
        });
        await recordCouponRedemption(tx, orgId, userId, input.couponId, amount);
        if (revenue) {
          await this.deps.revenueAnalytics.emit(tx, {
            type: revenue.type,
            orgId,
            plan: input.plan,
            previousPlan: revenue.previousPlan,
            mrr: revenue.mrr,
            amount: revenue.mrr,
            // Both come from PLAN_PRICES_PAISE, which is paise of PLATFORM_PRICE_CURRENCY —
            // not `price.currency`, which denominates what the customer was charged.
            currency: PLATFORM_PRICE_CURRENCY,
            metadata: { paymentId: input.paymentId, source: "verify-and-activate" },
            dedupeKey: `verify-and-activate:${input.paymentId}`,
          });
        }
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        if (isUniqueViolationOn(err, "uq_coupon_redemptions_coupon_org")) {
          throw new ConflictException("This coupon has already been used by your organization");
        }
        return { success: true, plan: input.plan, status: "ACTIVE" };
      }
      throw err;
    }

    await this.deps.planLimits.bust(orgId);
    this.deps.audit.log({
      action: "settings.updated",
      userId,
      orgId,
      targetType: "subscription",
      metadata: { plan: input.plan, paymentId: input.paymentId },
    });
    await grantPlanCredits(this.deps, orgId, userId, input);
    return { success: true, plan: input.plan, status: "ACTIVE" };
  }

  /**
   * What this organisation is charged, as an amount AND the currency denominating it.
   *
   * Both halves come from ONE source and are never mixed: the platform catalog row if the
   * plan has one, otherwise the built-in list. They used to disagree — the amount from the
   * INR-paise list, the currency from `accounting_settings.base_currency` — which charged a
   * USD-books tenant $999.00 for a ₹999.00 plan and then recorded 99900 "paise" as USD.
   *
   * The tenant's base currency is deliberately absent: it is what the tenant keeps its own
   * books in and has no bearing on what this vendor bills. Refusing checkout on a mismatch
   * would be wrong for the same reason — a US company may legitimately pay an INR invoice.
   */
  private async billablePrice(plan: Plan, billingCycle: BillingCycle) {
    const catalogPrice = await this.deps.catalog.getActivePriceForPlanTier(plan);
    // MINOR UNITS of `currency` on both branches: amountMinor as the catalog declares it,
    // PLAN_PRICES_PAISE as paise of PLATFORM_PRICE_CURRENCY.
    const monthlyAmountMinor = catalogPrice?.amountMinor ?? PLAN_PRICES_PAISE[plan];
    const currency = catalogPrice?.currency ?? PLATFORM_PRICE_CURRENCY;
    return {
      amount: billingCycle === "annual"
        ? Math.round(monthlyAmountMinor * 12 * (1 - ANNUAL_DISCOUNT_PCT))
        : monthlyAmountMinor,
      currency,
    };
  }
}
