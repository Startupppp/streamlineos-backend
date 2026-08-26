import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  billingProfiles,
  coupons,
  couponRedemptions,
  dunningAttempts,
  invoices,
  organizationMembers,
  organizations,
  platformPayments,
  subscriptionPayments,
  subscriptions,
} from "../../../db/schema";
import { providerWebhookEvents } from "../../../db/schema/billing/provider-webhook-events";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { logger } from "../../../common/logger/logger.service";
import { AiCreditsService } from "./ai-credits.service";
import { PlanLimitsService } from "./plan-limits.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { PaymentProviderResolver, type OrganizationPaymentProvider } from "../payments/payment-provider-resolver.service";
import {
  webhookEventSchema,
  type BillingCycle,
  type CreateCouponInput,
  type Plan,
  type RazorpayPayment,
  type UpdateBillingProfileInput,
  type UpdateCouponInput,
  type VerifyPaymentInput,
  type WebhookEvent,
} from "./dto/billing.schemas";
import {
  PLAN_LIMITS,
  PLAN_PRICES_PAISE,
  ANNUAL_DISCOUNT_PCT,
  buildPlanCatalog,
  TRIAL_PLAN,
} from "./plan-entitlements.constants";
import {
  runInNewTenantTransaction,
  runInTenantTransaction,
} from "../../../common/tenant/run-in-tenant-transaction";
import { ExternalEffectLedger, ExternalEffectLeaseBusyError } from "../../../common/outbox/external-effect-ledger";

interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

@Injectable()
export class BillingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly aiCredits: AiCreditsService,
    private readonly planLimits: PlanLimitsService,
    private readonly revenueAnalytics: RevenueAnalyticsService,
    private readonly providers: PaymentProviderResolver,
    private readonly externalEffectLedger: ExternalEffectLedger,
  ) {}

  async getSubscription(orgId: string) {
    const subscription = await this.db.query.subscriptions.findFirst({
      where: eq(subscriptions.orgId, orgId),
      with: {
        payments: {
          limit: 5,
          orderBy: (payment, { desc: descending }) => [descending(payment.createdAt)],
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

  async createOrder(orgId: string, userId: string, plan: Plan, billingCycle: BillingCycle = "monthly", couponId?: number) {
    const adapter = await this.providers.resolveConfigured(orgId);
    if (adapter === undefined || !adapter.isReady()) {
      throw new ServiceUnavailableException("Payment gateway not configured. Contact support.");
    }

    const monthlyPrice = PLAN_PRICES_PAISE[plan];
    if (!monthlyPrice) throw new BadRequestException("Invalid plan");

    let amount = billingCycle === "annual"
      ? Math.round(monthlyPrice * 12 * (1 - ANNUAL_DISCOUNT_PCT))
      : monthlyPrice;

    let couponDiscountAmount = 0;
    if (couponId) {
      const coupon = await this.db.query.coupons.findFirst({
        where: and(eq(coupons.id, couponId), eq(coupons.isActive, true)),
      });
      if (coupon) {
        const couponValue = parseFloat(coupon.value);
        couponDiscountAmount = coupon.type === "PERCENTAGE"
          ? Math.round(amount * (couponValue / 100))
          : Math.round(Math.min(couponValue * 100, amount));
        amount = Math.max(100, amount - couponDiscountAmount);
      }
    }

    const { providerOrderId } = await adapter.createOrder({
      amount: String(amount),
      currency: "INR",
      receipt: `sub_${orgId.slice(-8)}_${Date.now().toString().slice(-8)}`,
      notes: { orgId, plan, userId, billingCycle },
    });

    return {
      orderId: providerOrderId,
      amount,
      currency: "INR",
      keyId: adapter.publicKeyId(),
      plan,
      billingCycle,
      discountAmount: couponDiscountAmount,
    };
  }

  async verifyAndActivate(orgId: string, userId: string, input: VerifyPaymentInput) {
    const adapter = await this.providers.resolveConfigured(orgId);
    if (adapter === undefined || !adapter.isReady()) {
      throw new ServiceUnavailableException("Payment gateway not configured. Contact support.");
    }

    const valid = adapter.verifyPaymentSignature({
      orderId: input.razorpay_order_id,
      paymentId: input.razorpay_payment_id,
      signature: input.razorpay_signature,
    });
    if (!valid) {
      throw new BadRequestException("Payment verification failed: invalid signature");
    }

    const amount = PLAN_PRICES_PAISE[input.plan];
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    try {
      await this.db.transaction(async (tx) => {
        const existing = await tx.query.subscriptions.findFirst({
          where: eq(subscriptions.orgId, orgId),
        });

        let subscriptionId: number;
        if (existing) {
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
          currency: "INR",
          status: "captured",
          paidAt: now,
        });

        if (input.couponId !== undefined) {
          const [lockedCoupon] = await tx
            .select({
              id: coupons.id,
              maxUses: coupons.maxUses,
              usedCount: coupons.usedCount,
            })
            .from(coupons)
            .where(and(eq(coupons.id, input.couponId), eq(coupons.isActive, true)))
            .for("update")
            .limit(1);

          if (lockedCoupon) {
            if (lockedCoupon.maxUses !== null && lockedCoupon.usedCount >= lockedCoupon.maxUses) {
              throw new BadRequestException("This coupon has reached its usage limit");
            }

            await tx
              .update(coupons)
              .set({ usedCount: sql`${coupons.usedCount} + 1` })
              .where(eq(coupons.id, input.couponId));

            await tx.insert(couponRedemptions).values({
              couponId: input.couponId,
              orgId,
              userId,
            });
          }
        }
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === "23505") {
        if (pgErr.constraint === "uq_coupon_redemptions_coupon_org") {
          throw new ConflictException("This coupon has already been used by your organization");
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
        () => this.aiCredits.grantPlanCredits(orgId, input.plan, userId, input.razorpay_payment_id),
      );
    } catch (err: unknown) {
      if (err instanceof ExternalEffectLeaseBusyError) {
        logger.warn("[billing] plan credit grant already in flight", { orgId, plan: input.plan });
      } else {
        logger.error("[billing] plan credit grant failed", { orgId, plan: input.plan, err });
        throw new ServiceUnavailableException("Payment recorded but credits could not be granted. The system will retry automatically.");
      }
    }

    void this.revenueAnalytics
      .recordEvent({
        type: "new_subscription",
        orgId,
        plan: input.plan,
        mrr: PLAN_PRICES_PAISE[input.plan],
        amount: PLAN_PRICES_PAISE[input.plan],
        metadata: { paymentId: input.razorpay_payment_id, billingCycle: "monthly" },
      })
      .catch((err: unknown) => logger.warn("[billing] revenue event record failed", { orgId, err }));

    return { success: true, plan: input.plan, status: "ACTIVE" };
  }

  async validateCoupon(code: string, orgId: string, plan: Plan): Promise<{
    valid: boolean;
    couponId: number | null;
    type: "PERCENTAGE" | "FIXED" | null;
    value: number | null;
    discountAmount: number | null;
    message: string;
  }> {
    const normalizedCode = code.trim().toUpperCase();
    const coupon = await this.db.query.coupons.findFirst({
      where: and(
        eq(coupons.code, normalizedCode),
        eq(coupons.isActive, true),
      ),
    });

    if (!coupon) {
      return { valid: false, couponId: null, type: null, value: null, discountAmount: null, message: "Invalid coupon code" };
    }

    if (coupon.expiresAt && coupon.expiresAt < new Date()) {
      return { valid: false, couponId: null, type: null, value: null, discountAmount: null, message: "This coupon has expired" };
    }

    if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
      return { valid: false, couponId: null, type: null, value: null, discountAmount: null, message: "This coupon has reached its usage limit" };
    }

    if (coupon.applicablePlans && coupon.applicablePlans.length > 0 && !coupon.applicablePlans.includes(plan)) {
      return { valid: false, couponId: null, type: null, value: null, discountAmount: null, message: "This coupon is not applicable to the selected plan" };
    }

    const alreadyUsed = await this.db.query.couponRedemptions.findFirst({
      where: and(eq(couponRedemptions.couponId, coupon.id), eq(couponRedemptions.orgId, orgId)),
    });
    if (alreadyUsed) {
      return { valid: false, couponId: null, type: null, value: null, discountAmount: null, message: "This coupon has already been used by your organization" };
    }

    const baseAmount = PLAN_PRICES_PAISE[plan];
    const couponValue = parseFloat(coupon.value);
    const discountAmount =
      coupon.type === "PERCENTAGE"
        ? Math.round(baseAmount * (couponValue / 100))
        : Math.round(Math.min(couponValue * 100, baseAmount));

    return {
      valid: true,
      couponId: coupon.id,
      type: coupon.type as "PERCENTAGE" | "FIXED",
      value: couponValue,
      discountAmount,
      message: coupon.type === "PERCENTAGE"
        ? `${couponValue}% discount applied`
        : `â‚¹${couponValue} discount applied`,
    };
  }

  /**
   * Provider-neutral webhook entry point. Provider-specific signature verification and envelope
   * parsing stay inside the configured adapter; billing only applies the normalized event.
   */
  async handlePaymentProviderWebhook(
    orgId: string,
    providerKey: string,
    rawBody: string,
    signature: string,
  ): Promise<WebhookResult> {
    const adapter = await this.providers.resolve(orgId, providerKey);
    if (!adapter) {
      logger.warn("[billing] no payment provider registered for webhook verification");
      return { status: 503, body: { ok: false } };
    }
    if (!adapter.verifyWebhookSignature({ rawBody, signature })) {
      logger.warn(`[billing:${providerKey}] invalid webhook signature`);
      return { status: 401, body: { ok: false } };
    }

    const normalized = adapter.normalizeWebhook(rawBody);
    if (!normalized.ok) {
      return {
        status: 400,
        body: { ok: false, error: normalized.error === "invalid_json" ? "invalid JSON" : "invalid payload" },
      };
    }

    const parsed = webhookEventSchema.safeParse({ event: normalized.eventType, payload: normalized.payload });
    if (!parsed.success) {
      logger.warn(`[billing:${providerKey}] normalized webhook payload validation failed`, {
        issues: parsed.error.issues,
      });
      return { status: 400, body: { ok: false, error: "invalid payload" } };
    }
    const event: WebhookEvent = parsed.data;

    const payment = event.payload.payment?.entity;
    if (!payment) {
      return { status: 200, body: { ok: true, ignored: event.event } };
    }

    const providerEventId = normalized.providerEventId ?? payment.id;
    try {
      // The tenant interceptor resolves an org from the portal header or the
      // authenticated user, and this route is @Public() with neither — so no
      // transaction is open and no GUC is set. Every table touched here has RLS,
      // and app.current_org_id() raises 42501 rather than returning null, so a
      // bare this.db write is denied outright. The URL orgId is this route's
      // tenant selector, so it is what opens the transaction.
      const inserted = await runInNewTenantTransaction(this.db, orgId, (tx) =>
        tx
          .insert(providerWebhookEvents)
          .values({
            orgId,
            provider: providerKey,
            providerEventId,
            eventType: event.event,
            rawPayload: JSON.parse(rawBody),
          })
          .onConflictDoNothing({
            target: [providerWebhookEvents.provider, providerWebhookEvents.providerEventId],
          })
          .returning({ id: providerWebhookEvents.id }),
      );
      if (inserted.length === 0) {
        logger.warn(`[billing:${providerKey}] duplicate event ignored`, { providerEventId });
        return { status: 200, body: { ok: true, duplicate: true } };
      }
    } catch (error) {
      logger.error(`[billing:${providerKey}] failed to record provider event`, { error });
      return { status: 500, body: { ok: false } };
    }

    const org = await this.findOrgFromNotes(payment.notes);
    if (org && org.id !== orgId) {
      logger.warn(`[billing:${providerKey}] webhook organization does not match endpoint organization`);
      return { status: 400, body: { ok: false, error: "organization mismatch" } };
    }
    const resolvedOrg = org ?? { id: orgId };

    try {
      await this.persistPayment(payment, resolvedOrg.id);
    } catch (error) {
      logger.error(`[billing:${providerKey}] failed to persist payment`, { error });
      return { status: 500, body: { ok: false } };
    }

    if (
      event.event === "payment.captured" &&
      payment.status === "captured" &&
      payment.notes?.packId &&
      resolvedOrg
    ) {
      const packId = parseInt(String(payment.notes.packId), 10);
      if (!isNaN(packId)) {
        try {
          await this.externalEffectLedger.execute(
            {
              organizationId: resolvedOrg.id,
              producerEventId: payment.id,
              effectKey: `${payment.id}:pack-credit-grant`,
              effectType: "billing.ai-pack-credit-grant",
              providerIdempotency: "NONE",
            },
            () => this.aiCredits.grantAiPackCreditsFromWebhook(resolvedOrg.id, packId, payment.id),
          );
        } catch (err: unknown) {
          if (err instanceof ExternalEffectLeaseBusyError)
            return { status: 503, body: { ok: false, error: "grant in-flight" } };
          logger.error(`[billing:${providerKey}] ai pack credit grant failed`, { orgId: resolvedOrg.id, packId, paymentId: payment.id, err });
          return { status: 500, body: { ok: false } };
        }
      }
    }

    if (event.event === "payment.failed" && payment.status === "failed" && resolvedOrg) {
      try {
        await this.transitionToPastDue(resolvedOrg.id, payment.id);
      } catch (err: unknown) {
        logger.error(`[billing:${providerKey}] PAST_DUE transition failed`, { orgId: resolvedOrg.id, paymentId: payment.id, err });
        return { status: 500, body: { ok: false } };
      }
    }

    await runInNewTenantTransaction(this.db, orgId, (tx) =>
      tx
        .update(providerWebhookEvents)
        .set({ processedAt: new Date() })
        .where(
          and(
            eq(providerWebhookEvents.orgId, orgId),
            eq(providerWebhookEvents.provider, providerKey),
            eq(providerWebhookEvents.providerEventId, providerEventId),
          ),
        ),
    );

    return { status: 200, body: { ok: true } };
  }

  /** Compatibility API for internal callers that still use the original method name. */
  handleRazorpayWebhook(orgId: string, rawBody: string, signature: string): Promise<WebhookResult> {
    return this.handlePaymentProviderWebhook(orgId, "razorpay", rawBody, signature);
  }

  private async persistPayment(payment: RazorpayPayment, orgId: string | null): Promise<void> {
    const fields = {
      razorpayPaymentId: payment.id,
      razorpayOrderId: payment.order_id ?? null,
      orgId,
      customerEmail: payment.email ?? null,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      method: payment.method ?? null,
      description: payment.description ?? null,
      metadata: payment.notes ? { notes: payment.notes } : null,
      capturedAt: payment.status === "captured" ? new Date() : null,
      refundedAt: payment.status === "refunded" ? new Date() : null,
    };

    if (orgId !== null) {
      await runInTenantTransaction(this.db, async (tx) => {
        await tx
          .insert(platformPayments)
          .values(fields)
          .onConflictDoUpdate({ target: platformPayments.razorpayPaymentId, set: fields });
      }, { orgId });
    } else {
      await this.db
        .insert(platformPayments)
        .values(fields)
        .onConflictDoUpdate({ target: platformPayments.razorpayPaymentId, set: fields });
    }
  }

  private async findOrgFromNotes(
    notes?: Record<string, string>,
  ): Promise<{ id: string } | null> {
    if (!notes) return null;
    // Subscription orders embed orgId directly — prefer direct lookup over slug search.
    const directId = notes.orgId ?? notes.org_id;
    if (directId) {
      const org = await this.db.query.organizations.findFirst({
        where: eq(organizations.id, directId),
        columns: { id: true },
      });
      if (org) return org;
    }
    const slug = notes.org_slug ?? notes.organization_slug ?? notes.orgSlug;
    if (!slug) return null;
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.slug, slug),
      columns: { id: true },
    });
    return org ?? null;
  }

  private async transitionToPastDue(orgId: string, paymentId: string): Promise<void> {
    const now = new Date();
    await runInTenantTransaction(this.db, async (tx) => {
      const [existing] = await tx
        .select({ id: subscriptions.id, metadata: subscriptions.metadata })
        .from(subscriptions)
        .where(and(eq(subscriptions.orgId, orgId), eq(subscriptions.status, "ACTIVE")))
        .for("update")
        .limit(1);
      if (!existing) return;
      const meta = existing.metadata ?? {};
      await tx
        .update(subscriptions)
        .set({
          status: "PAST_DUE",
          updatedAt: now,
          metadata: {
            ...meta,
            pastDueAt: now.toISOString(),
            lastFailedPaymentId: paymentId,
          },
        })
        .where(eq(subscriptions.id, existing.id));
      await tx
        .insert(dunningAttempts)
        .values({
          orgId,
          subscriptionId: existing.id,
          periodStart: now,
          milestone: "D+1",
          status: "PENDING",
          providerRetryId: paymentId,
        })
        .onConflictDoNothing({
          target: [
            dunningAttempts.orgId,
            dunningAttempts.subscriptionId,
            dunningAttempts.periodStart,
            dunningAttempts.milestone,
          ],
        });
    }, { orgId });
    await this.planLimits.bust(orgId);
    logger.info("[billing] subscription transitioned to PAST_DUE", { orgId, paymentId });
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
        throw new ServiceUnavailableException("Payment gateway not configured. Contact support.");
      }
      const { providerOrderId: addonOrderId } = await addonAdapter.createOrder({
        amount: String(pack.priceInPaise * quantity),
        currency: "INR",
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
        currency: "INR",
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

  async listCoupons() {
    const all = await this.db.query.coupons.findMany({
      orderBy: (c, { desc: d }) => [d(c.createdAt)],
      with: { redemptions: true },
      limit: 100,
    });
    return all;
  }

  async createCoupon(data: CreateCouponInput) {
    try {
      const [created] = await this.db.insert(coupons).values({
        code: data.code.toUpperCase(),
        type: data.type,
        value: String(data.value),
        maxUses: data.maxUses,
        applicablePlans: data.applicablePlans,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
      }).returning();
      return created;
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
        throw new ConflictException("A coupon with this code already exists");
      }
      throw err;
    }
  }

  async updateCoupon(id: number, data: UpdateCouponInput) {
    const [updated] = await this.db.update(coupons)
      .set({
        ...(data.code !== undefined ? { code: data.code.toUpperCase() } : {}),
        ...(data.type !== undefined ? { type: data.type } : {}),
        ...(data.value !== undefined ? { value: String(data.value) } : {}),
        ...(data.maxUses !== undefined ? { maxUses: data.maxUses } : {}),
        ...(data.applicablePlans !== undefined ? { applicablePlans: data.applicablePlans } : {}),
        ...(data.expiresAt !== undefined ? { expiresAt: new Date(data.expiresAt) } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(eq(coupons.id, id))
      .returning();
    if (!updated) throw new NotFoundException("Coupon not found");
    return updated;
  }

  async deleteCoupon(id: number) {
    await this.db.update(coupons).set({ isActive: false, updatedAt: new Date() }).where(eq(coupons.id, id));
    return { success: true };
  }

  listAddons() {
    return {
      addons: [
        { id: "ai_credits", name: "AI Credit Packs", description: "Purchase additional AI processing credits", icon: "Zap", available: true, href: "/billing/ai-credits" },
        { id: "extra_storage", name: "Extra Storage", description: "Add 100GB of document and file storage", icon: "HardDrive", priceInPaise: 49900, available: true },
        { id: "whatsapp", name: "WhatsApp Messaging", description: "1000 WhatsApp messages/month", icon: "MessageSquare", priceInPaise: 199900, available: false, comingSoon: true },
        { id: "sms_credits", name: "SMS Credits", description: "Bulk SMS for notifications and alerts", icon: "Phone", priceInPaise: 99900, available: false, comingSoon: true },
        { id: "voice_ai", name: "Voice AI", description: "AI-powered voice calling and transcription", icon: "Mic", priceInPaise: 499900, available: false, comingSoon: true },
        { id: "white_label", name: "White Label", description: "Remove StreamlineOS branding", icon: "Tag", priceInPaise: 999900, available: false, comingSoon: true },
        { id: "custom_domain", name: "Custom Domain", description: "Use your own domain for the platform", icon: "Globe", priceInPaise: 299900, available: false, comingSoon: true },
        { id: "premium_support", name: "Premium Support", description: "24/7 dedicated support with SLA guarantees", icon: "HeadphonesIcon", priceInPaise: 1999900, available: false, comingSoon: true },
        { id: "api_capacity", name: "API Capacity", description: "Higher API rate limits and throughput", icon: "Server", priceInPaise: 149900, available: false, comingSoon: true },
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
    if (affiliate.pendingPayout === 0) throw new BadRequestException("No pending payout available");
    return {
      success: true,
      amount: affiliate.pendingPayout,
      message: "Payout request submitted. Our team will process it within 5-7 business days.",
    };
  }

  async getSummary(orgId: string) {
    const [subscription, invoiceStats] = await Promise.all([
      this.db.query.subscriptions.findFirst({
        where: eq(subscriptions.orgId, orgId),
        columns: { plan: true, status: true, trialEndsAt: true, currentPeriodEnd: true },
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
        ? Math.max(0, Math.ceil((new Date(subscription.trialEndsAt).getTime() - now) / 86_400_000))
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
      isConfigured: (await this.providers.resolveConfigured(orgId))?.isReady() ?? false,
    };
  }
}
