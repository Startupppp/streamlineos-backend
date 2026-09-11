import {
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  accountingSettings,
  couponRedemptions,
  coupons,
  subscriptionPayments,
  subscriptions,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { type DbOrTx } from "../../../common/rbac/access-invalidate";
import { getPostgresErrorDetails } from "../../../common/db/postgres-error";
import { AuditService } from "../../../common/audit/audit.service";
import { logger } from "../../../common/logger/logger.service";
import {
  ExternalEffectLedger,
  ExternalEffectLeaseBusyError,
} from "../../../common/outbox/external-effect-ledger";
import { PaymentProviderResolver } from "../payments/payment-provider-resolver.service";
import { AiCreditsService } from "./ai-credits.service";
import { BillingCoupons } from "./billing-coupons";
import { type BillingCycle, type Plan, type VerifyPaymentInput } from "./dto/billing.schemas";
import { PlanLimitsService } from "./plan-limits.service";
import { ANNUAL_DISCOUNT_PCT, PLAN_PRICES_PAISE } from "./plan-entitlements.constants";
import { ProrationLedgerService } from "./proration-ledger.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { classifyPlanChange } from "./revenue-events";
import { VersionedCatalogService } from "./versioned-catalog.service";
import { applyDiscount, couponDiscountPaise } from "./coupon-pricing";

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

  async currencyForOrg(orgId: string, fallback?: string): Promise<string> {
    if (typeof this.deps.db.select !== "function") return fallback ?? "INR";

    const [settings] = await this.deps.db
      .select({ baseCurrency: accountingSettings.baseCurrency })
      .from(accountingSettings)
      .where(eq(accountingSettings.orgId, orgId));
    return settings?.baseCurrency ?? fallback ?? "INR";
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

    const price = await this.billablePrice(orgId, plan, billingCycle);
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

  async verifyAndActivate(orgId: string, userId: string, input: VerifyPaymentInput) {
    const adapter = await this.deps.providers.resolveConfigured(orgId);
    if (adapter === undefined || !adapter.isReady()) {
      throw new ServiceUnavailableException("Payment gateway not configured. Contact support.");
    }
    const valid = adapter.verifyPaymentSignature({
      orderId: input.razorpay_order_id,
      paymentId: input.razorpay_payment_id,
      signature: input.razorpay_signature,
    });
    if (!valid) throw new BadRequestException("Payment verification failed: invalid signature");

    const billingCycle = input.billingCycle ?? "monthly";
    const price = await this.billablePrice(orgId, input.plan, billingCycle);
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
          await this.recordProrationForPlanChange(tx, orgId, existing, input.plan, now);
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
          razorpayPaymentId: input.razorpay_payment_id,
          razorpayOrderId: input.razorpay_order_id,
          amountPaise: amount,
          currency: price.currency,
          status: "captured",
          paidAt: now,
        });
        await this.recordCouponRedemption(tx, orgId, userId, input.couponId, amount);
        if (revenue) {
          await this.deps.revenueAnalytics.emit(tx, {
            type: revenue.type,
            orgId,
            plan: input.plan,
            previousPlan: revenue.previousPlan,
            mrr: revenue.mrr,
            amount: revenue.mrr,
            metadata: { paymentId: input.razorpay_payment_id, source: "verify-and-activate" },
          });
        }
      });
    } catch (err: unknown) {
      /**
       * Drizzle wraps the driver error and leaves the SQLSTATE on `.cause`, and
       * postgres-js spells the constraint `constraint_name`, so the guard that
       * stood here found neither: a second redemption of one coupon by one
       * organisation (`uq_coupon_redemptions_coupon_org`), or a replayed
       * payment, was a 500. The transaction above is a savepoint inside a
       * request, so returning success leaves the request transaction usable.
       */
      const pgErr = getPostgresErrorDetails(err);
      if (pgErr.code === "23505") {
        if (pgErr.constraint === "uq_coupon_redemptions_coupon_org") {
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
      metadata: { plan: input.plan, paymentId: input.razorpay_payment_id },
    });
    await this.grantPlanCredits(orgId, userId, input);
    return { success: true, plan: input.plan, status: "ACTIVE" };
  }

  private async billablePrice(orgId: string, plan: Plan, billingCycle: BillingCycle) {
    const catalogPrice = await this.deps.catalog.getActivePriceForPlanTier(plan);
    const currency = await this.currencyForOrg(orgId, catalogPrice?.currency);
    const monthlyAmount = catalogPrice?.amountMinor ?? PLAN_PRICES_PAISE[plan];
    return {
      amount: billingCycle === "annual"
        ? Math.round(monthlyAmount * 12 * (1 - ANNUAL_DISCOUNT_PCT))
        : monthlyAmount,
      currency,
    };
  }

  private async recordProrationForPlanChange(
    tx: DbOrTx,
    orgId: string,
    existing: { id: number; plan: Plan; currentPeriodStart: Date | null; currentPeriodEnd: Date | null },
    newPlan: Plan,
    effectiveFrom: Date,
  ): Promise<void> {
    if (existing.plan === newPlan) return;
    const { currentPeriodStart, currentPeriodEnd } = existing;
    if (!currentPeriodStart || !currentPeriodEnd) return;
    if (effectiveFrom < currentPeriodStart || effectiveFrom > currentPeriodEnd) return;
    const [oldPrice, newPrice] = await Promise.all([
      this.deps.catalog.getActivePriceForPlanTier(existing.plan),
      this.deps.catalog.getActivePriceForPlanTier(newPlan),
    ]);
    if (!oldPrice || !newPrice) {
      this.logger.error("Plan change recorded no proration line: no active price version for this tier", {
        orgId,
        subscriptionId: existing.id,
        from: existing.plan,
        to: newPlan,
        missing: !oldPrice ? existing.plan : newPlan,
      });
      return;
    }
    await this.deps.prorationLedger.recordPlanChange({
      orgId,
      subscriptionId: existing.id,
      idempotencyKey: `sub:${existing.id}:${newPrice.id}:${effectiveFrom.toISOString()}`,
      oldPriceVersionId: oldPrice.id,
      newPriceVersionId: newPrice.id,
      oldQuantity: 1,
      newQuantity: 1,
      periodStart: currentPeriodStart,
      periodEnd: currentPeriodEnd,
      effectiveFrom,
    }, tx);
  }

  private async recordCouponRedemption(
    tx: DbOrTx,
    orgId: string,
    userId: string,
    couponId: number | undefined,
    amount: number,
  ): Promise<void> {
    if (couponId === undefined) return;
    const [lockedCoupon] = await tx.select({
      id: coupons.id,
      type: coupons.type,
      value: coupons.value,
      maxUses: coupons.maxUses,
      usedCount: coupons.usedCount,
    }).from(coupons).where(and(eq(coupons.id, couponId), eq(coupons.isActive, true))).for("update").limit(1);
    if (!lockedCoupon) return;
    if (lockedCoupon.maxUses !== null && lockedCoupon.usedCount >= lockedCoupon.maxUses) {
      throw new BadRequestException("This coupon has reached its usage limit");
    }
    await tx.update(coupons).set({ usedCount: sql`${coupons.usedCount} + 1` }).where(eq(coupons.id, couponId));
    const discountPaise = couponDiscountPaise({
      id: lockedCoupon.id,
      type: lockedCoupon.type,
      value: lockedCoupon.value,
      maxUses: lockedCoupon.maxUses,
      usedCount: lockedCoupon.usedCount,
      applicablePlans: null,
      expiresAt: null,
    }, amount);
    await tx.insert(couponRedemptions).values({
      couponId,
      orgId,
      userId,
      amountPaise: discountPaise,
    });
  }

  private async grantPlanCredits(orgId: string, userId: string, input: VerifyPaymentInput): Promise<void> {
    try {
      await this.deps.externalEffectLedger.execute({
        organizationId: orgId,
        producerEventId: input.razorpay_payment_id,
        effectKey: `${input.razorpay_payment_id}:plan-credit-grant`,
        effectType: "billing.plan-credit-grant",
        providerIdempotency: "NONE",
      }, () => this.deps.aiCredits.grantPlanCredits(orgId, input.plan, userId, input.razorpay_payment_id));
    } catch (err: unknown) {
      if (err instanceof ExternalEffectLeaseBusyError) {
        logger.warn("[billing] plan credit grant already in flight", { orgId, plan: input.plan });
        return;
      }
      logger.error("[billing] plan credit grant failed", { orgId, plan: input.plan, err });
      throw new ServiceUnavailableException(
        "Payment recorded but credits could not be granted. The system will retry automatically.",
      );
    }
  }
}
