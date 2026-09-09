import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  billingProfiles,
  coupons,
  couponRedemptions,
  invoices,
  organizationMembers,
  subscriptionPayments,
  subscriptions,
  glBooks,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { getPostgresErrorDetails } from "../../../common/db/postgres-error";
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
  }

  private readonly webhooks: BillingWebhookHandler;
  private readonly couponAdmin: BillingCoupons;
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
      .select({ baseCurrency: glBooks.baseCurrency })
      .from(glBooks)
      .where(eq(glBooks.orgId, orgId));
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
      /**
       * Both halves came off the wrong object. Drizzle wraps the driver error
       * and leaves the SQLSTATE on `.cause`, and postgres-js spells the
       * constraint field `constraint_name`, so `pgErr.code` and
       * `pgErr.constraint` were each undefined and a second redemption of the
       * same coupon by the same organisation surfaced as a 500.
       * `uq_coupon_redemptions_coupon_org` — (coupon_id, org_id).
       */
      const pgErr = getPostgresErrorDetails(err);
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
    return { apps: [], addons: [] };
  }

  async purchaseAddon(orgId: string, addonId: string, quantity: number) {
    if (addonId.startsWith("ai_pack_")) {
      const packId = parseInt(addonId.replace("ai_pack_", ""), 10);
      const packs = await this.aiCredits.listPacks();
      const pack = packs.find((p) => p.id === packId);
      if (!pack) throw new BadRequestException("AI credit pack not found");
      const addonAdapter = await this.providers.resolveConfigured(orgId);
      if (addonAdapter === undefined || !addonAdapter.isReady()) {
        throw new ServiceUnavailableException(
          "Payment gateway not configured. Contact support.",
        );
      }
      const currency = await this.currencyForOrg(orgId);
      const { providerOrderId: addonOrderId } = await addonAdapter.createOrder({
        amount: String(pack.priceInPaise * quantity),
        currency,
        receipt: `aip_${packId}_${orgId.slice(-8)}_${Date.now().toString().slice(-8)}`,
        notes: {
          orgId: String(orgId),
          packId: String(packId),
          quantity: String(quantity),
        },
      });
      return {
        orderId: addonOrderId,
        amount: pack.priceInPaise * quantity,
        currency,
        keyId: addonAdapter.publicKeyId(),
        pack,
      };
    }
    throw new BadRequestException("Unknown addon type");
  }

  async getBillingProfile(orgId: string) {
    const [existing] = await this.db
      .select()
      .from(billingProfiles)
      .where(eq(billingProfiles.orgId, orgId));
    if (existing) return existing;
    const [profile] = await this.db
      .insert(billingProfiles)
      .values({ orgId })
      .returning();
    return profile;
  }

  async updateBillingProfile(orgId: string, data: UpdateBillingProfileInput) {
    await this.getBillingProfile(orgId);
    const [updated] = await this.db
      .update(billingProfiles)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(billingProfiles.orgId, orgId))
      .returning();
    return updated;
  }


  listAddons() {
    return {
      addons: [
        {
          id: "ai_credits",
          name: "AI Credit Packs",
          description: "Purchase additional AI processing credits",
          icon: "Zap",
          available: true,
          href: "/billing/ai-credits",
        },
        {
          id: "extra_storage",
          name: "Extra Storage",
          description: "Add 100GB of document and file storage",
          icon: "HardDrive",
          priceInPaise: 49900,
          available: true,
        },
        {
          id: "whatsapp",
          name: "WhatsApp Messaging",
          description: "1000 WhatsApp messages/month",
          icon: "MessageSquare",
          priceInPaise: 199900,
          available: false,
          comingSoon: true,
        },
        {
          id: "sms_credits",
          name: "SMS Credits",
          description: "Bulk SMS for notifications and alerts",
          icon: "Phone",
          priceInPaise: 99900,
          available: false,
          comingSoon: true,
        },
        {
          id: "voice_ai",
          name: "Voice AI",
          description: "AI-powered voice calling and transcription",
          icon: "Mic",
          priceInPaise: 499900,
          available: false,
          comingSoon: true,
        },
        {
          id: "white_label",
          name: "White Label",
          description: "Remove StreamlineOS branding",
          icon: "Tag",
          priceInPaise: 999900,
          available: false,
          comingSoon: true,
        },
        {
          id: "custom_domain",
          name: "Custom Domain",
          description: "Use your own domain for the platform",
          icon: "Globe",
          priceInPaise: 299900,
          available: false,
          comingSoon: true,
        },
        {
          id: "premium_support",
          name: "Premium Support",
          description: "24/7 dedicated support with SLA guarantees",
          icon: "HeadphonesIcon",
          priceInPaise: 1999900,
          available: false,
          comingSoon: true,
        },
        {
          id: "api_capacity",
          name: "API Capacity",
          description: "Higher API rate limits and throughput",
          icon: "Server",
          priceInPaise: 149900,
          available: false,
          comingSoon: true,
        },
      ],
    };
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
    const [{ seatLimit }, memberRows, invitationRows] = await Promise.all([
      this.planLimits.getEntitlements(orgId),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(organizationMembers)
        .where(eq(organizationMembers.orgId, orgId)),
      this.db.execute(sql`
        SELECT COUNT(*)::int AS count FROM invitations
        WHERE org_id = ${orgId}
          AND status = 'PENDING'
          AND accepted_at IS NULL
          AND expires_at > NOW()
      `),
    ]);

    const activeMembers = Number(memberRows[0]?.count ?? 0);
    const pendingInvitations = Number(invitationRows[0]?.["count"] ?? 0);
    const used = activeMembers + pendingInvitations;
    const total = seatLimit;

    return {
      total,
      used,
      available: total === null ? null : Math.max(0, total - used),
      activeMembers,
      pendingInvitations,
    };
  }

  async requestAffiliatePayoutRequest(orgId: string) {
    const affiliate = await this.db.query.affiliates.findFirst({
      where: (a, { eq }) => eq(a.orgId, orgId),
    });
    if (!affiliate) throw new NotFoundException("Affiliate not found");
    if (affiliate.pendingPayout === 0)
      throw new BadRequestException("No pending payout available");
    return {
      success: true,
      amount: affiliate.pendingPayout,
      message:
        "Payout request submitted. Our team will process it within 5-7 business days.",
    };
  }

  async getSummary(orgId: string) {
    const [subscription, invoiceStats] = await Promise.all([
      this.db.query.subscriptions.findFirst({
        where: eq(subscriptions.orgId, orgId),
        columns: {
          plan: true,
          status: true,
          trialEndsAt: true,
          currentPeriodEnd: true,
        },
      }),
      this.db
        .select({
          totalPaid: sql<string>`coalesce(sum(case when ${invoices.status} = 'PAID' then ${invoices.total}::numeric else 0 end), 0)::text`,
          totalOutstanding: sql<string>`coalesce(sum(case when ${invoices.status} in ('ISSUED','FAILED') then ${invoices.total}::numeric else 0 end), 0)::text`,
          draft: sql<number>`count(case when ${invoices.status} = 'DRAFT' then 1 end)::int`,
          issued: sql<number>`count(case when ${invoices.status} = 'ISSUED' then 1 end)::int`,
          paid: sql<number>`count(case when ${invoices.status} = 'PAID' then 1 end)::int`,
          failed: sql<number>`count(case when ${invoices.status} = 'FAILED' then 1 end)::int`,
          voided: sql<number>`count(case when ${invoices.status} = 'VOIDED' then 1 end)::int`,
        })
        .from(invoices)
        .where(eq(invoices.orgId, orgId)),
    ]);

    const now = Date.now();
    const trialDaysRemaining =
      subscription?.status === "TRIAL" && subscription.trialEndsAt
        ? Math.max(
            0,
            Math.ceil(
              (new Date(subscription.trialEndsAt).getTime() - now) / 86_400_000,
            ),
          )
        : null;

    return {
      subscription: subscription
        ? {
            plan: subscription.plan,
            status: subscription.status,
            trialEndsAt: subscription.trialEndsAt ?? null,
            trialDaysRemaining,
            currentPeriodEnd: subscription.currentPeriodEnd ?? null,
            isActive: subscription.status === "ACTIVE",
            isTrial: subscription.status === "TRIAL",
          }
        : null,
      invoiceStats: invoiceStats[0] ?? {
        totalPaid: "0",
        totalOutstanding: "0",
        draft: 0,
        issued: 0,
        paid: 0,
        failed: 0,
        voided: 0,
      },
      isConfigured:
        (await this.providers.resolveConfigured(orgId))?.isReady() ?? false,
    };
  }
}
