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
import {
  PLATFORM_PAYMENT_PROVIDER,
  type PlatformPaymentProvider,
} from "./platform-payment-provider";
import { PlatformPaymentRegistry } from "./platform-payment-registry";
import { currencyForCountry, priceFor, annualPrice } from "./plan-pricing";
import { determineTax } from "./tax/tax-determination";
import { AiCreditsService } from "./ai-credits.service";
import { PlanLimitsService } from "./plan-limits.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { PaymentProviderResolver, type OrganizationPaymentProvider } from "../payments/payment-provider-resolver.service";
import {
  planSchema,
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
    @Inject(PLATFORM_PAYMENT_PROVIDER)
    private readonly razorpay: PlatformPaymentProvider,
    private readonly paymentRegistry: PlatformPaymentRegistry,
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

    /*
      "Can this deployment take money at all", not "is Razorpay set up".

      The frontend disables every upgrade button on this flag, so answering it
      from Razorpay alone left a Stripe-only deployment unable to sell -- the
      same unreachability as the precondition removed from `createOrder`, one
      screen earlier. `razorpayKeyId` still means what its name says; the
      per-order key comes back from `createOrder`, which knows the currency.
    */
    return {
      subscription: subscription ?? null,
      razorpayKeyId: this.razorpay.getPublishableKey(),
      isConfigured: Object.values(this.paymentRegistry.available()).some(Boolean),
    };
  }

  async createOrder(orgId: string, userId: string, plan: Plan, billingCycle: BillingCycle = "monthly", couponId?: number) {
    /*
      No Razorpay precondition here.

      This used to refuse every order unless RAZORPAY_KEY_ID was set, which made
      the registry below unreachable on exactly the deployment ticket 02 exists
      for: a Stripe-only one could not sell anything, and the error blamed a
      gateway the buyer was never going to be charged through. `forCurrency`
      already refuses -- naming the currency nothing can take -- when no
      configured provider can charge, so a second, cruder gate in front of it
      could only ever be wrong.
    */

    /*
      What the customer is charged, in the currency they were quoted.

      This read the INR-only `PLAN_PRICES_PAISE` and then charged `currency:
      "INR"` regardless, while `/pricing` quoted from the four-currency table and
      told a visitor "you will be charged in USD". The two disagreed, and the
      page was the one telling the truth about what the customer expected.

      The billing profile's country decides it. A tenant with no profile is still
      charged INR — the currency they are billed in today — rather than the
      pricing page's stranger-fallback, so nobody is re-denominated without
      having said where they bill from.
    */
    const profile = await this.db.query.billingProfiles.findFirst({
      where: eq(billingProfiles.orgId, orgId),
    });
    const currency = currencyForCountry(profile?.country, "INR");
    const monthly = priceFor(plan, currency);
    const priced = billingCycle === "annual"
      ? annualPrice(monthly, ANNUAL_DISCOUNT_PCT)
      : monthly;

    let amount = priced.amountMinor;

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

    /*
      Tax determined before the charge, from the buyer's own jurisdiction, and
      carried on the order so activation stores what was actually applied rather
      than recomputing it against whatever the rates say later.

      `determineTax` was written, tested and then called by nothing; this is the
      call site ticket 04 was missing. An unconfigured jurisdiction throws, which
      is the right failure: charging a number we cannot defend is worse than
      refusing to charge.
    */
    const tax = determineTax(amount, {
      country: profile?.country ?? "IN",
      state: profile?.state,
      taxId: profile?.gstin,
      isExempt: profile?.isTaxExempt ?? false,
    });

    /*
      The provider is chosen by the currency, not assumed. `forCurrency` refuses
      with PaymentRequiredException when nothing configured can take that
      currency, which is why there is no fallback branch here.
    */
    const { provider, isPreferred } = this.paymentRegistry.forCurrency(currency);

    const order = await provider.createOrder({
      amount: tax.grossMinor,
      currency,
      receipt: `sub_${orgId.slice(-8)}_${Date.now().toString().slice(-8)}`,
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

  async verifyAndActivate(orgId: string, userId: string, input: VerifyPaymentInput) {
    if (!this.razorpay.isConfigured()) {
      throw new ServiceUnavailableException("Payment gateway not configured. Contact support.");
    }

    const valid = this.razorpay.verifyPaymentSignature(
      input.razorpay_order_id,
      input.razorpay_payment_id,
      input.razorpay_signature,
    );
    if (!valid) {
      throw new BadRequestException("Payment verification failed: invalid signature");
    }

    /*
      Every commercial fact comes from the order, not from `input`.

      The signature is computed over `orderId|paymentId`, so it proves the
      payment happened -- it says nothing about what was bought. Reading the plan
      and the cycle from the request body meant the buyer declared them: an order
      created and paid at STARTER could be verified with `plan: "ENTERPRISE"` and
      the subscription would be written at the tier the body asked for. The
      amount had the same shape, from the other direction: `createOrder` charged
      twelve discounted months for an annual order, and this recomputed the
      MONTHLY price to store, so an annual customer was billed ~23,990 and
      recorded as having paid 2,499, then given one month of access.

      The order is the record of the sale, held by the party that took the money.
      `notes` is what `createOrder` attached to it, echoed back verbatim.
    */
    const order = await this.razorpay.fetchOrder(input.razorpay_order_id);

    /*
      An order carries the org it was created for. Without this check a valid
      order id belonging to another tenant activates a subscription here -- the
      signature would verify, because it is a real order of ours. Cross-tenant
      misses are 404 by convention, but this one is a 400: the caller supplied a
      malformed pairing rather than probed for a record's existence.
    */
    if (order.notes.orgId !== orgId) {
      throw new BadRequestException("Payment verification failed: order belongs to another organisation");
    }

    if (order.notes.plan !== input.plan) {
      throw new BadRequestException(
        "Payment verification failed: this order was not for the requested plan",
      );
    }

    const plan = planSchema.parse(order.notes.plan);
    const billingCycle: BillingCycle = order.notes.billingCycle === "annual" ? "annual" : "monthly";
    const amount = order.amount;

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + (billingCycle === "annual" ? 12 : 1));

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
              plan,
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
              plan,
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
          // Ticket 02's expand half: written alongside, so a second provider has
          // somewhere to store and every existing reader keeps working.
          provider: this.razorpay.providerKey,
          providerPaymentRef: input.razorpay_payment_id,
          providerOrderRef: input.razorpay_order_id,
          amount: (amount / 100).toFixed(2),
          // What the order was denominated in, not what the only configured
          // provider happens to charge today.
          currency: order.currency,
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
        plan,
        /*
          MRR is a monthly figure, so an annual sale contributes a twelfth of
          what it charged -- not the whole thing, and not the list monthly price.
          All four fields previously came from the plan's monthly rate with the
          cycle hardcoded, so an annual PROFESSIONAL sale was booked as 2,499 of
          monthly revenue instead of 23,990.40 taken once. Same mistake as the
          activation path itself made; the figures now come from the order.
        */
        mrr: billingCycle === "annual" ? Math.round(amount / 12) : amount,
        amount,
        metadata: { paymentId: input.razorpay_payment_id, billingCycle },
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
    /**
     * The tenant context, because `payment_providers` is behind RLS.
     *
     * This route is `@Public()` — a provider posts to it with no session — so
     * nothing upstream has set `app.organization_id`, and the registry read was
     * refused with 42501 before a signature was ever checked. Every webhook a
     * live tenant received answered 500. It only worked at all against a
     * connection that bypasses RLS.
     *
     * The org comes from the URL path, which is untrusted, and that is fine
     * here: it selects which secret to verify against, and the verification
     * below is what authenticates the request. Reading one tenant's provider row
     * grants nothing on its own, and a wrong org simply fails the signature.
     *
     * The writes further down already run in this same context; only the read
     * that decides how to verify was outside it.
     */
    const adapter = await runInNewTenantTransaction(this.db, orgId, () =>
      this.providers.resolve(orgId, providerKey),
    );
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

  /*
    Upserts on (provider, provider_payment_ref), not on the Razorpay id.

    A duplicate webhook delivery is the thing this has to survive, and it has to
    survive it for every provider. Targeting `razorpay_payment_id` only worked
    while Razorpay was the only one: since `0531` that column is nullable and its
    unique index is partial, so a repeated Stripe delivery would miss this
    conflict target entirely and hit `uniq_platform_payments_provider_ref` as an
    unhandled 23505 instead of being absorbed.
  */
  private async persistPayment(payment: RazorpayPayment, orgId: string | null): Promise<void> {
    const fields = {
      razorpayPaymentId: payment.id,
      razorpayOrderId: payment.order_id ?? null,
      provider: this.razorpay.providerKey,
      providerPaymentRef: payment.id,
      providerOrderRef: payment.order_id ?? null,
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
          .onConflictDoUpdate({
            target: [platformPayments.provider, platformPayments.providerPaymentRef],
            set: fields,
          });
      }, { orgId });
    } else {
      await this.db
        .insert(platformPayments)
        .values(fields)
        .onConflictDoUpdate({
            target: [platformPayments.provider, platformPayments.providerPaymentRef],
            set: fields,
          });
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
      if (!this.razorpay.isConfigured()) {
        throw new ServiceUnavailableException("Payment gateway not configured. Contact support.");
      }
      const order = await this.razorpay.createOrder({
        amount: pack.priceInPaise * quantity,
        // The second of the two sites that becomes tenant-aware with a second
        // provider. The pack price is already denominated in paise by name.
        currency: "INR",
        receipt: `aip_${packId}_${orgId.slice(-8)}_${Date.now().toString().slice(-8)}`,
        notes: {
          orgId: String(orgId),
          packId: String(packId),
          quantity: String(quantity),
        },
      });
      return {
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: this.razorpay.getPublishableKey(),
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
      // Same question as `getSubscription`, same answer: can this deployment
      // take money at all, not is Razorpay set up.
      isConfigured: Object.values(this.paymentRegistry.available()).some(Boolean),
    };
  }
}
