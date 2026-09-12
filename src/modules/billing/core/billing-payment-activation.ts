import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
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
  PLAN_PRICES_PAISE,
  PLATFORM_PRICE_CURRENCY,
} from "./plan-entitlements.constants";
import { ProrationLedgerService } from "./proration-ledger.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { classifyPlanChange } from "./revenue-events";
import { VersionedCatalogService } from "./versioned-catalog.service";
import { applyDiscount, resolveQuotePrice } from "./coupon-pricing";
import {
  grantPlanCredits,
  recordProrationForPlanChange,
} from "./billing-activation-recorders";
import { isUniqueViolation, isUniqueViolationOn } from "../../../common/db/postgres-error";
import { SubscriptionPurchaseService } from "./subscription-purchase.service";
import type { SubscriptionPurchase } from "../../../db/schema/billing/subscription-purchases";
import type { PlatformMerchantService } from "../payments/platform-merchant.service";

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
  platformMerchant: PlatformMerchantService;
  purchaseService?: SubscriptionPurchaseService;
}

export class BillingPaymentActivation {
  private readonly couponAdmin: BillingCoupons;
  private readonly logger = new Logger(BillingPaymentActivation.name);
  private readonly purchaseService: SubscriptionPurchaseService;

  constructor(private readonly deps: BillingPaymentActivationDeps) {
    this.couponAdmin = new BillingCoupons(deps.db);
    this.purchaseService = deps.purchaseService ?? new SubscriptionPurchaseService(deps.db);
  }

  async createOrder(
    orgId: string,
    userId: string,
    plan: Plan,
    billingCycle: BillingCycle = "monthly",
    couponId?: number,
  ) {
    const platformMerchant = this.deps.platformMerchant;
    const provider = platformMerchant.resolve();
    if (!provider || !provider.isReady()) {
      throw new ServiceUnavailableException("Payment gateway not configured. Contact support.");
    }
    if (!PLAN_PRICES_PAISE[plan]) throw new BadRequestException("Invalid plan");

    const readiness = platformMerchant.readiness();
    const environment = platformMerchant.environment();
    const merchantKeyId = readiness.publicKeyId;
    if (!readiness.configured || environment === null || merchantKeyId === null) {
      throw new ServiceUnavailableException("Payment gateway not configured. Contact support.");
    }

    const price = await this.billablePrice(plan, billingCycle);
    const baseAmount = price.amount;
    let amount = baseAmount;
    let couponDiscountAmount = 0;
    let reservedCouponId: number | null = null;

    const catalogVersion = await this.deps.catalog
      .getActivePriceForPlanTier(plan)
      .then((p) => p?.id ?? null);

    if (couponId !== undefined) {
      const reservation = await this.deps.db.transaction(async (tx) => {
        return this.couponAdmin.reserve(tx, couponId, orgId, plan, baseAmount);
      });
      if (!reservation.reserved) {
        throw new BadRequestException(reservation.reason);
      }
      couponDiscountAmount = reservation.discountAmountMinor;
      amount = applyDiscount(baseAmount, couponDiscountAmount);
      reservedCouponId = couponId;
    }

    let providerOrderId: string;
    try {
      const result = await provider.createOrder({
        amount: String(amount),
        currency: price.currency,
        receipt: `sub_${orgId.slice(-8)}_${Date.now().toString().slice(-8)}`,
        notes: { orgId, plan, userId, billingCycle },
      });
      providerOrderId = result.providerOrderId;
    } catch (err: unknown) {
      await this.releaseReservation(orgId, reservedCouponId, "order creation error");
      throw err;
    }

    try {
      const purchase = await this.deps.db.transaction(async (tx) => {
        return this.purchaseService.create(tx, {
          orgId,
          createdByUserId: userId,
          providerKey: provider.providerKey,
          environment,
          merchantKeyId,
          providerOrderId,
          plan,
          billingCycle,
          catalogVersion,
          baseAmountMinor: baseAmount,
          discountAmountMinor: couponDiscountAmount,
          amountMinor: amount,
          currency: price.currency,
          couponId: reservedCouponId,
        });
      });

      return {
        orderId: providerOrderId,
        purchaseId: purchase.id,
        amount,
        currency: price.currency,
        keyId: merchantKeyId,
        environment,
        plan,
        billingCycle,
        discountAmount: couponDiscountAmount,
      };
    } catch (err: unknown) {
      await this.releaseReservation(orgId, reservedCouponId, "purchase record write error");
      throw err;
    }
  }

  private async releaseReservation(
    orgId: string,
    reservedCouponId: number | null,
    context: string,
  ): Promise<void> {
    if (reservedCouponId === null) return;
    await this.deps.db
      .transaction(async (tx) => {
        await this.couponAdmin.release(tx, reservedCouponId);
      })
      .catch((releaseErr: unknown) => {
        this.logger.error(`[billing] coupon reservation release failed after ${context}`, {
          orgId,
          couponId: reservedCouponId,
          releaseErr,
        });
      });
  }

  async verifyAndActivate(orgId: string, userId: string, input: ConfirmCheckoutInput) {
    const platformMerchant = this.deps.platformMerchant;
    const adapter = platformMerchant.resolve();
    if (adapter === undefined || !adapter.isReady()) {
      throw new ServiceUnavailableException("Payment gateway not configured. Contact support.");
    }

    const valid = adapter.verifyPaymentSignature({
      orderId: input.orderId,
      paymentId: input.paymentId,
      signature: input.signature,
    });
    if (!valid) throw new BadRequestException("Payment verification failed: invalid signature");

    const purchase = await this.purchaseService.findByOrderId(this.deps.db, input.orderId);
    if (!purchase) throw new NotFoundException("Purchase record not found");

    if (purchase.orgId !== orgId) {
      this.logger.warn("[billing] verifyAndActivate: order id belongs to a different org", {
        requestOrgId: orgId,
        purchaseOrgId: purchase.orgId,
        orderId: input.orderId,
      });
      throw new NotFoundException("Purchase record not found");
    }

    const readiness = platformMerchant.readiness();
    const currentEnv = platformMerchant.environment();
    if (
      readiness.publicKeyId === null ||
      purchase.merchantKeyId !== readiness.publicKeyId ||
      purchase.environment !== currentEnv
    ) {
      throw new BadRequestException(
        "Payment cannot be confirmed: merchant configuration has changed since this order was created",
      );
    }

    const snapshot = await adapter.fetchPayment(input.paymentId);
    if (!snapshot) {
      throw new BadRequestException("Payment not found at provider");
    }
    if (snapshot.orderId !== purchase.providerOrderId) {
      throw new BadRequestException("Payment does not match the order");
    }
    if (snapshot.status !== "captured") {
      throw new BadRequestException(
        `Payment is not captured (current status: ${snapshot.status})`,
      );
    }
    if (snapshot.amountMinor !== purchase.amountMinor || snapshot.currency !== purchase.currency) {
      await this.purchaseService.markFailed(this.deps.db, purchase.id, orgId, {
        amountMismatch: {
          expected: { amountMinor: purchase.amountMinor, currency: purchase.currency },
          actual: { amountMinor: snapshot.amountMinor, currency: snapshot.currency },
        },
      });
      throw new BadRequestException(
        "Payment amount does not match the order amount; activation refused",
      );
    }

    if (purchase.status === "ACTIVATED") {
      return this.buildStoredOutcome(purchase, true);
    }

    const isLate = purchase.status === "EXPIRED" || purchase.status === "CANCELLED";

    return this.runActivationTransaction(orgId, userId, input.paymentId, purchase, isLate);
  }

  async performActivationFromWebhook(
    orgId: string,
    paymentId: string,
    capturedAmountMinor: number,
    capturedCurrency: string,
    purchase: SubscriptionPurchase,
  ) {
    if (purchase.status === "ACTIVATED") {
      return this.buildStoredOutcome(purchase, true);
    }
    const isLate = purchase.status === "EXPIRED" || purchase.status === "CANCELLED";
    return this.runActivationTransaction(orgId, null, paymentId, purchase, isLate, capturedAmountMinor, capturedCurrency);
  }

  private async runActivationTransaction(
    orgId: string,
    userId: string | null,
    paymentId: string,
    purchase: SubscriptionPurchase,
    isLate: boolean,
    capturedAmountMinor?: number,
    capturedCurrency?: string,
  ) {
    const now = new Date();
    const billingCycle = purchase.billingCycle;
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + (billingCycle === "annual" ? 12 : 1));

    const finalAmountMinor = capturedAmountMinor ?? purchase.amountMinor;
    const finalCurrency = capturedCurrency ?? purchase.currency;
    const plan = purchase.plan;

    let activatedPurchase: SubscriptionPurchase | null = null;

    try {
      activatedPurchase = await this.deps.db.transaction(async (tx): Promise<SubscriptionPurchase | null> => {
        const locked = await this.purchaseService.lockForActivation(tx, purchase.id, orgId);
        if (!locked) return null;

        if (locked.status === "ACTIVATED") return locked;

        const existing = await tx.query.subscriptions.findFirst({
          where: eq(subscriptions.orgId, orgId),
        });
        const revenue = classifyPlanChange(
          existing ? { plan: existing.plan, status: existing.status } : null,
          plan,
        );

        let subscriptionId: number;
        if (existing) {
          await recordProrationForPlanChange(this.deps, this.logger, tx, orgId, existing, plan, now);
          await tx.update(subscriptions).set({
            plan,
            status: "ACTIVE",
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            updatedAt: now,
          }).where(eq(subscriptions.id, existing.id));
          subscriptionId = existing.id;
        } else {
          const [created] = await tx.insert(subscriptions).values({
            orgId,
            plan,
            status: "ACTIVE",
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
          }).returning({ id: subscriptions.id });
          subscriptionId = created.id;
        }

        await tx.insert(subscriptionPayments).values({
          orgId,
          subscriptionId,
          razorpayPaymentId: paymentId,
          razorpayOrderId: purchase.providerOrderId,
          amountPaise: finalAmountMinor,
          currency: finalCurrency,
          status: "captured",
          paidAt: now,
          metadata: isLate ? { lateCapture: true } : undefined,
        });

        if (purchase.couponId !== null && purchase.couponId !== undefined) {
          await this.couponAdmin.redeem(tx, purchase.couponId, orgId, userId ?? "", finalAmountMinor);
        }

        if (revenue) {
          await this.deps.revenueAnalytics.emit(tx, {
            type: revenue.type,
            orgId,
            plan,
            previousPlan: revenue.previousPlan,
            mrr: revenue.mrr,
            amount: revenue.mrr,
            currency: PLATFORM_PRICE_CURRENCY,
            metadata: { paymentId, source: "verify-and-activate" },
            dedupeKey: `verify-and-activate:${paymentId}`,
          });
        }

        const activated = await this.purchaseService.markActivated(tx, purchase.id, orgId, {
          paymentId,
          capturedAmountMinor: finalAmountMinor,
          capturedCurrency: finalCurrency,
          subscriptionId,
          activatedAt: now,
        });

        if (!activated) {
          throw new ConcurrentActivationError();
        }

        return activated;
      });
    } catch (err: unknown) {
      if (err instanceof ConflictException) throw err;
      if (err instanceof ConcurrentActivationError) {
        const fresh = await this.purchaseService.findByOrderId(this.deps.db, purchase.providerOrderId);
        if (fresh?.status === "ACTIVATED") {
          return this.buildStoredOutcome(fresh, true);
        }
      }
      if (isUniqueViolation(err)) {
        if (isUniqueViolationOn(err, "uq_coupon_redemptions_coupon_org")) {
          throw new ConflictException("This coupon has already been used by your organization");
        }
        throw err;
      }
      throw err;
    }

    const activated: SubscriptionPurchase | null = activatedPurchase;
    if (activated !== null && activated.status === "ACTIVATED") {
      const activatedAt = activated.activatedAt;
      const wasAlreadyActivated =
        activatedAt !== null && activatedAt !== undefined && activatedAt < now;

      await this.deps.planLimits.bust(orgId);
      this.deps.audit.log({
        action: "settings.updated",
        userId: userId ?? "",
        orgId,
        targetType: "subscription",
        metadata: { plan, paymentId, isLate },
      });
      await grantPlanCredits(this.deps, orgId, userId ?? "", paymentId, plan);

      return {
        success: true as const,
        plan,
        billingCycle: purchase.billingCycle,
        status: "ACTIVE",
        currentPeriodEnd: periodEnd.toISOString(),
        alreadyActivated: wasAlreadyActivated,
      };
    }

    const fresh = await this.purchaseService.findByOrderId(this.deps.db, purchase.providerOrderId);
    if (fresh?.status === "ACTIVATED") {
      return this.buildStoredOutcome(fresh, true);
    }

    throw new ServiceUnavailableException("Activation did not complete; please retry");
  }

  private buildStoredOutcome(purchase: SubscriptionPurchase, alreadyActivated: boolean) {
    const billingCycle = purchase.billingCycle;
    const activatedAt = purchase.activatedAt ?? new Date();
    const periodEnd = new Date(activatedAt);
    periodEnd.setMonth(periodEnd.getMonth() + (billingCycle === "annual" ? 12 : 1));

    return {
      success: true as const,
      plan: purchase.plan,
      billingCycle: purchase.billingCycle,
      status: "ACTIVE",
      currentPeriodEnd: periodEnd.toISOString(),
      alreadyActivated,
    };
  }

  private async billablePrice(plan: Plan, billingCycle: BillingCycle) {
    const catalogPrice = await this.deps.catalog.getActivePriceForPlanTier(plan);
    return resolveQuotePrice(plan, billingCycle, catalogPrice ?? null);
  }
}

class ConcurrentActivationError extends Error {
  constructor() {
    super("concurrent activation: markActivated returned 0 rows");
  }
}
