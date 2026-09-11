import { BadRequestException, ConflictException, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { subscriptionPayments, subscriptions } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { ExternalEffectLedger } from "../../../common/outbox/external-effect-ledger";
import { AiCreditsService } from "./ai-credits.service";
import { BillingCoupons } from "./billing-coupons";
import { type BillingCycle, type ConfirmCheckoutInput, type Plan } from "./dto/billing.schemas";
import { PlanLimitsService } from "./plan-limits.service";
import { PLAN_PRICES_PAISE, PLATFORM_PRICE_CURRENCY } from "./plan-entitlements.constants";
import { PlatformPaymentRegistry } from "./platform-payment-registry";
import {
  billablePrice,
  taxFor,
  type PlatformBuyer,
} from "./billing-platform-pricing";
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
  /**
   * The PLATFORM's own gateways, not the tenant's.
   *
   * `PaymentProviderResolver` reads `payment_providers`, which is an organisation's
   * own Razorpay/Stripe account for charging ITS customers — the opposite direction
   * of travel, with different credentials (see the header of
   * `db/schema/billing/payment-providers.ts`). Resolving a subscription charge
   * through it creates the platform's order inside the buyer's own gateway, so the
   * platform is never paid and `StripePlatformWebhookService` — which verifies
   * against `STRIPE_WEBHOOK_SECRET` — never sees a matching intent.
   */
  registry: PlatformPaymentRegistry;
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
    buyer: PlatformBuyer = {},
  ) {
    /*
      No provider precondition ahead of the price.

      A flat "is a gateway configured" gate here is what made the registry
      unreachable on a Stripe-only deployment: nothing could be sold and the
      refusal blamed a gateway the buyer was never going to be charged through.
      `forCurrency` below already refuses — naming the currency nothing can take —
      so a second, cruder gate in front of it could only ever be wrong.
    */
    if (!PLAN_PRICES_PAISE[plan]) throw new BadRequestException("Invalid plan");

    const price = await billablePrice(this.deps.catalog, plan, billingCycle, buyer.country);
    const baseAmount = price.amount;
    let amount = baseAmount;
    let couponDiscountAmount = 0;
    if (couponId) {
      const evaluation = await this.couponAdmin.evaluate(couponId, orgId, plan, baseAmount);
      if (!evaluation.eligible) throw new BadRequestException(evaluation.reason);
      couponDiscountAmount = evaluation.discountAmount;
      amount = applyDiscount(baseAmount, couponDiscountAmount);
    }

    const tax = taxFor(amount, buyer);

    /*
      The provider is chosen by the currency, not assumed, and the choice says
      whether it was the preferred one — an INR sale settled through Stripe is
      still a sale worth taking, but the customer's statement will show a
      conversion and somebody has to be able to warn them.
    */
    const { provider, isPreferred } = this.deps.registry.forCurrency(price.currency);

    const order = await provider.createOrder({
      amount: tax.grossMinor,
      currency: price.currency,
      receipt: `sub_${orgId.slice(-8)}_${Date.now().toString().slice(-8)}`,
      // Echoed back verbatim by both providers, and the only place the terms of
      // the sale survive the round trip through the browser.
      notes: {
        orgId,
        plan,
        userId,
        billingCycle,
        netMinor: String(tax.netMinor),
        taxMinor: String(tax.taxMinor),
        taxTreatment: tax.treatment,
        ratesVersion: tax.inputs.ratesVersion,
      },
    });
    return {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: provider.getPublishableKey(),
      provider: provider.providerKey,
      /** False means their statement will show a conversion; the UI must say so. */
      isPreferredProvider: isPreferred,
      plan,
      billingCycle,
      discountAmount: couponDiscountAmount,
      netMinor: tax.netMinor,
      taxMinor: tax.taxMinor,
    };
  }

  async verifyAndActivate(
    orgId: string,
    userId: string,
    input: ConfirmCheckoutInput,
    buyer: PlatformBuyer = {},
  ) {
    const billingCycle = input.billingCycle ?? "monthly";
    const price = await billablePrice(this.deps.catalog, input.plan, billingCycle, buyer.country);

    /*
      Verified by the provider that took the money, selected by the same rule
      `createOrder` used. Verifying a platform charge against a tenant-held
      secret would let an organisation that has connected its own gateway sign
      its own subscription payments — the argument `StripePlatformWebhookService`
      makes for the webhook half applies identically here.
    */
    const { provider } = this.deps.registry.forCurrency(price.currency);
    const valid = provider.verifyPaymentSignature(input.orderId, input.paymentId, input.signature);
    if (!valid) throw new BadRequestException("Payment verification failed: invalid signature");

    // What was actually charged, tax included, on the same determination the
    // order was created with — a row that records the net is a row that does not
    // reconcile against the gateway. The coupon is a discount on the PRICE, so it
    // is still struck against the net, exactly as `createOrder` struck it.
    const netAmount = price.amount;
    const amount = taxFor(netAmount, buyer).grossMinor;
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
        await recordCouponRedemption(tx, orgId, userId, input.couponId, netAmount);
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
      /**
       * Both halves used to come off the wrong object. Drizzle wraps the driver
       * error and leaves the SQLSTATE on `.cause`, and postgres-js spells the
       * constraint field `constraint_name`, so reading `.code` and `.constraint`
       * off the thrown value found neither, and a second redemption of the same
       * coupon by the same organisation surfaced as a 500. The shared helpers
       * read both where they actually are. `uq_coupon_redemptions_coupon_org` —
       * (coupon_id, org_id).
       */
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

}
