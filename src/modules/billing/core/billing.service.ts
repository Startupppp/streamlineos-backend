import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  coupons,
  couponRedemptions,
  subscriptionPayments,
  subscriptions,
  accountingSettings,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { logger } from "../../../common/logger/logger.service";
import { AiCreditsService } from "./ai-credits.service";
import { PlanLimitsService } from "./plan-limits.service";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { ProrationLedgerService } from "./proration-ledger.service";
import { VersionedCatalogService } from "./versioned-catalog.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { classifyPlanChange } from "./revenue-events";
import { PaymentProviderResolver } from "../payments/payment-provider-resolver.service";
import { PaymentWebhookHealthService } from "../payments/payment-webhook-health.service";
import { PaymentAnalyticsService } from "../payments/payment-analytics.service";
import {
  applyDiscount,
  couponDiscountPaise,
} from "./coupon-pricing";
import {
  BillingWebhookHandler,
  type WebhookResult,
} from "./billing-webhook.handler";
import { BillingCoupons } from "./billing-coupons";
import {
  type BillingCycle,
  type CreateCouponInput,
  type Plan,
  type UpdateBillingProfileInput,
  type UpdateCouponInput,
  type VerifyPaymentInput,
} from "./dto/billing.schemas";
import {
  PLAN_PRICES_PAISE,
  ANNUAL_DISCOUNT_PCT,
  buildPlanCatalog,
  TRIAL_PLAN,
} from "./plan-entitlements.constants";
import {
  ExternalEffectLedger,
  ExternalEffectLeaseBusyError,
} from "../../../common/outbox/external-effect-ledger";
import { BillingProfileService } from "./billing-profile.service";
import { BillingMarketplace } from "./billing-marketplace";
import { BillingAccountOverview } from "./billing-account-overview";

@Injectable()
export class BillingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly aiCredits: AiCreditsService,
    private readonly planLimits: PlanLimitsService,
    private readonly prorationLedger: ProrationLedgerService,
    private readonly catalog: VersionedCatalogService,
    private readonly revenueAnalytics: RevenueAnalyticsService,
    private readonly providers: PaymentProviderResolver,
    private readonly externalEffectLedger: ExternalEffectLedger,
    private readonly paymentWebhooks: PaymentWebhookHealthService,
    private readonly paymentNotices: PaymentAnalyticsService,
    private readonly billingProfile: BillingProfileService,
  ) {
    this.couponAdmin = new BillingCoupons(this.db);
    this.webhooks = new BillingWebhookHandler({
      db: this.db,
      aiCredits: this.aiCredits,
      planLimits: this.planLimits,
      revenueAnalytics: this.revenueAnalytics,
      providers: this.providers,
      externalEffectLedger: this.externalEffectLedger,
      paymentWebhooks: this.paymentWebhooks,
      paymentNotices: this.paymentNotices,
    });
    this.marketplace = new BillingMarketplace(
      this.aiCredits,
      this.providers,
      this.currencyForOrg.bind(this),
    );
    this.accountOverview = new BillingAccountOverview(
      this.db,
      this.planLimits,
      this.providers,
    );
  }

  private readonly webhooks: BillingWebhookHandler;
  private readonly couponAdmin: BillingCoupons;
  private readonly marketplace: BillingMarketplace;
  private readonly accountOverview: BillingAccountOverview;
  private readonly logger = new Logger(BillingService.name);

  private async billablePrice(orgId: string, plan: Plan, billingCycle: BillingCycle) {
    const catalogPrice = await this.catalog.getActivePriceForPlanTier(plan);
    const currency = await this.currencyForOrg(orgId, catalogPrice?.currency);
    const monthlyAmount = catalogPrice?.amountMinor ?? PLAN_PRICES_PAISE[plan];
    const amount = billingCycle === "annual"
      ? Math.round(monthlyAmount * 12 * (1 - ANNUAL_DISCOUNT_PCT))
      : monthlyAmount;
    return {
      amount,
      currency,
    };
  }

  private async currencyForOrg(orgId: string, fallback?: string): Promise<string> {
    if (typeof this.db.select !== "function") {
      return fallback ?? "INR";
    }

    const [settings] = await this.db
      .select({ baseCurrency: accountingSettings.baseCurrency })
      .from(accountingSettings)
      .where(eq(accountingSettings.orgId, orgId));
    return settings?.baseCurrency ?? fallback ?? "INR";
  }

  /** A missing price version is reported, never thrown: the payment already captured and must not roll back. */
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
      this.catalog.getActivePriceForPlanTier(existing.plan),
      this.catalog.getActivePriceForPlanTier(newPlan),
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

    await this.prorationLedger.recordPlanChange(
      {
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
      },
      tx,
    );
  }

  async getSubscription(orgId: string) {
    const subscription = await this.db.query.subscriptions.findFirst({
      where: eq(subscriptions.orgId, orgId),
      with: {
        payments: {
          limit: 5,
          orderBy: (payment, { desc: descending }) => [
            descending(payment.createdAt),
          ],
        },
      },
    });

    const adapter = await this.providers.resolveConfigured(orgId);
    return {
      subscription: subscription ?? null,
      razorpayKeyId: adapter?.publicKeyId() ?? null,
      isConfigured: adapter?.isReady() ?? false,
    };
  }

  async createOrder(
    orgId: string,
    userId: string,
    plan: Plan,
    billingCycle: BillingCycle = "monthly",
    couponId?: number,
  ) {
    const adapter = await this.providers.resolveConfigured(orgId);
    if (adapter === undefined || !adapter.isReady()) {
      throw new ServiceUnavailableException(
        "Payment gateway not configured. Contact support.",
      );
    }

    if (!PLAN_PRICES_PAISE[plan]) throw new BadRequestException("Invalid plan");

    const price = await this.billablePrice(orgId, plan, billingCycle);
    const baseAmount = price.amount;
    let amount = baseAmount;
    let couponDiscountAmount = 0;

    if (couponId) {
      // Without these rules checkout discounted a coupon redemption then refused.
      const evaluation = await this.couponAdmin.evaluate(
        couponId,
        orgId,
        plan,
        baseAmount,
      );
      if (!evaluation.eligible)
        throw new BadRequestException(evaluation.reason);
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

  async verifyAndActivate(
    orgId: string,
    userId: string,
    input: VerifyPaymentInput,
  ) {
    const adapter = await this.providers.resolveConfigured(orgId);
    if (adapter === undefined || !adapter.isReady()) {
      throw new ServiceUnavailableException(
        "Payment gateway not configured. Contact support.",
      );
    }

    const valid = adapter.verifyPaymentSignature({
      orderId: input.razorpay_order_id,
      paymentId: input.razorpay_payment_id,
      signature: input.razorpay_signature,
    });
    if (!valid) {
      throw new BadRequestException(
        "Payment verification failed: invalid signature",
      );
    }

    const billingCycle = input.billingCycle ?? "monthly";
    const price = await this.billablePrice(orgId, input.plan, billingCycle);
    const amount = price.amount;
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + (billingCycle === "annual" ? 12 : 1));

    try {
      await this.db.transaction(async (tx) => {
        const existing = await tx.query.subscriptions.findFirst({
          where: eq(subscriptions.orgId, orgId),
        });

        const revenue = classifyPlanChange(
          existing ? { plan: existing.plan, status: existing.status } : null,
          input.plan,
        );

        let subscriptionId: number;
        if (existing) {
          await this.recordProrationForPlanChange(tx, orgId, existing, input.plan, now);
          await tx
            .update(subscriptions)
            .set({
              plan: input.plan,
              status: "ACTIVE",
              currentPeriodStart: now,
              currentPeriodEnd: periodEnd,
              updatedAt: now,
            })
            .where(eq(subscriptions.id, existing.id));
          subscriptionId = existing.id;
        } else {
          const [created] = await tx
            .insert(subscriptions)
            .values({
              orgId,
              plan: input.plan,
              status: "ACTIVE",
              currentPeriodStart: now,
              currentPeriodEnd: periodEnd,
            })
            .returning({ id: subscriptions.id });
          subscriptionId = created.id;
        }

        await tx.insert(subscriptionPayments).values({
          orgId,
          subscriptionId,
          razorpayPaymentId: input.razorpay_payment_id,
          razorpayOrderId: input.razorpay_order_id,
          amount: (amount / 100).toFixed(2),
          currency: price.currency,
          status: "captured",
          paidAt: now,
        });

        if (input.couponId !== undefined) {
          const [lockedCoupon] = await tx
            .select({
              id: coupons.id,
              type: coupons.type,
              value: coupons.value,
              maxUses: coupons.maxUses,
              usedCount: coupons.usedCount,
            })
            .from(coupons)
            .where(
              and(eq(coupons.id, input.couponId), eq(coupons.isActive, true)),
            )
            .for("update")
            .limit(1);

          if (lockedCoupon) {
            if (
              lockedCoupon.maxUses !== null &&
              lockedCoupon.usedCount >= lockedCoupon.maxUses
            ) {
              throw new BadRequestException(
                "This coupon has reached its usage limit",
              );
            }

            await tx
              .update(coupons)
              .set({ usedCount: sql`${coupons.usedCount} + 1` })
              .where(eq(coupons.id, input.couponId));

            const discountPaise = couponDiscountPaise(
              {
                id: lockedCoupon.id,
                type: lockedCoupon.type,
                value: lockedCoupon.value,
                maxUses: lockedCoupon.maxUses,
                usedCount: lockedCoupon.usedCount,
                applicablePlans: null,
                expiresAt: null,
              },
              amount,
            );

            await tx.insert(couponRedemptions).values({
              couponId: input.couponId,
              orgId,
              userId,
              amount: (discountPaise / 100).toFixed(2),
            });
          }
        }

        // Inside the activating transaction, so the event and the state change commit together.
        if (revenue) {
          await this.revenueAnalytics.emit(tx, {
            type: revenue.type,
            orgId,
            plan: input.plan,
            previousPlan: revenue.previousPlan,
            mrr: revenue.mrr,
            amount: revenue.mrr,
            metadata: {
              paymentId: input.razorpay_payment_id,
              source: "verify-and-activate",
            },
          });
        }
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === "23505") {
        if (pgErr.constraint === "uq_coupon_redemptions_coupon_org") {
          throw new ConflictException(
            "This coupon has already been used by your organization",
          );
        }
        return { success: true, plan: input.plan, status: "ACTIVE" };
      }
      throw err;
    }

    await this.planLimits.bust(orgId);

    this.audit.log({
      action: "settings.updated",
      userId,
      orgId,
      targetType: "subscription",
      metadata: { plan: input.plan, paymentId: input.razorpay_payment_id },
    });

    try {
      await this.externalEffectLedger.execute(
        {
          organizationId: orgId,
          producerEventId: input.razorpay_payment_id,
          effectKey: `${input.razorpay_payment_id}:plan-credit-grant`,
          effectType: "billing.plan-credit-grant",
          providerIdempotency: "NONE",
        },
        () =>
          this.aiCredits.grantPlanCredits(
            orgId,
            input.plan,
            userId,
            input.razorpay_payment_id,
          ),
      );
    } catch (err: unknown) {
      if (err instanceof ExternalEffectLeaseBusyError) {
        logger.warn("[billing] plan credit grant already in flight", {
          orgId,
          plan: input.plan,
        });
      } else {
        logger.error("[billing] plan credit grant failed", {
          orgId,
          plan: input.plan,
          err,
        });
        throw new ServiceUnavailableException(
          "Payment recorded but credits could not be granted. The system will retry automatically.",
        );
      }
    }

    return { success: true, plan: input.plan, status: "ACTIVE" };
  }

  validateCoupon(code: string, orgId: string, plan: Plan) {
    return this.couponAdmin.validate(code, orgId, plan);
  }

  listCoupons() {
    return this.couponAdmin.list();
  }

  createCoupon(data: CreateCouponInput) {
    return this.couponAdmin.create(data);
  }

  updateCoupon(id: number, data: UpdateCouponInput) {
    return this.couponAdmin.update(id, data);
  }

  deleteCoupon(id: number) {
    return this.couponAdmin.remove(id);
  }


  handlePaymentProviderWebhook(
    orgId: string,
    providerKey: string,
    rawBody: string,
    signature: string,
  ): Promise<WebhookResult> {
    return this.webhooks.handle(orgId, providerKey, rawBody, signature);
  }

  handleRazorpayWebhook(
    orgId: string,
    rawBody: string,
    signature: string,
  ): Promise<WebhookResult> {
    return this.webhooks.handle(orgId, "razorpay", rawBody, signature);
  }

  listProvisioningFailures(orgId: string) {
    return this.webhooks.listProvisioningFailures(orgId);
  }

  getPlans() {
    return { plans: buildPlanCatalog(), trialPlan: TRIAL_PLAN };
  }

  getMarketplace() {
    return this.marketplace.getMarketplace();
  }

  async purchaseAddon(orgId: string, addonId: string, quantity: number) {
    return this.marketplace.purchaseAddon(orgId, addonId, quantity);
  }

  async getBillingProfile(orgId: string) {
    return this.billingProfile.get(orgId);
  }

  async updateBillingProfile(orgId: string, data: UpdateBillingProfileInput) {
    return this.billingProfile.update(orgId, data);
  }


  listAddons() {
    return this.marketplace.listAddons();
  }

  /**
   * Must agree with what actually blocks an invite. `PlanLimitsService`'s
   * "members" counter is `organization_members + unexpired PENDING invitations`
   * and its limit honours `negotiated_seats` for ENTERPRISE — this used to read
   * the raw `PLAN_LIMITS.members[plan]` and count members only, so an
   * enterprise org saw its base plan limit instead of the seats it bought, and
   * the panel's own copy ("seats are reserved when you send invitations")
   * contradicted the number beside it. The breakdown is returned so the UI can
   * show WHERE the seats went rather than a single opaque total.
   */
  async getSeatInfo(orgId: string) {
    return this.accountOverview.getSeatInfo(orgId);
  }

  async requestAffiliatePayoutRequest(orgId: string) {
    return this.accountOverview.requestAffiliatePayoutRequest(orgId);
  }

  async getSummary(orgId: string) {
    return this.accountOverview.getSummary(orgId);
  }
}
