import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  billingProfiles,
  coupons,
  couponRedemptions,
  invoices,
  organizationMembers,
  organizations,
  platformPayments,
  subscriptionPayments,
  subscriptions,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { logger } from "../../common/logger/logger.service";
import { RazorpayService } from "./razorpay.service";
import { AiCreditsService } from "./ai-credits.service";
import {
  webhookEventSchema,
  type BillingCycle,
  type Plan,
  type RazorpayPayment,
  type UpdateBillingProfileInput,
  type VerifyPaymentInput,
  type WebhookEvent,
} from "./dto/billing.schemas";

const PLAN_PRICES: Record<Plan, number> = {
  STARTER: 99900,
  PROFESSIONAL: 249900,
  ENTERPRISE: 499900,
};

interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

@Injectable()
export class BillingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly razorpay: RazorpayService,
    private readonly audit: AuditService,
    private readonly aiCredits: AiCreditsService,
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

    return {
      subscription: subscription ?? null,
      razorpayKeyId: this.razorpay.getKeyId(),
      isConfigured: this.razorpay.isConfigured(),
    };
  }

  async createOrder(orgId: string, userId: string, plan: Plan, billingCycle: BillingCycle = "monthly", couponId?: number) {
    if (!this.razorpay.isConfigured()) {
      throw new ServiceUnavailableException("Payment gateway not configured. Contact support.");
    }

    const monthlyPrice = PLAN_PRICES[plan];
    if (!monthlyPrice) throw new BadRequestException("Invalid plan");

    let amount = billingCycle === "annual"
      ? Math.round(monthlyPrice * 12 * 0.8)
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

    const order = await this.razorpay.createOrder({
      amount,
      receipt: `sub_${orgId.slice(-8)}_${Date.now().toString().slice(-8)}`,
      notes: { orgId, plan, userId, billingCycle },
    });

    return {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: this.razorpay.getKeyId(),
      plan,
      billingCycle,
      discountAmount: couponDiscountAmount,
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

    const amount = PLAN_PRICES[input.plan];
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

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
    });

    this.audit.log({
      action: "settings.updated",
      userId,
      orgId,
      targetType: "subscription",
      metadata: { plan: input.plan, paymentId: input.razorpay_payment_id },
    });

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

    const baseAmount = PLAN_PRICES[plan];
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
        : `₹${couponValue} discount applied`,
    };
  }

  async handleRazorpayWebhook(rawBody: string, signature: string): Promise<WebhookResult> {
    if (!this.razorpay.verifyWebhookSignature(rawBody, signature)) {
      logger.warn("[razorpay] invalid webhook signature");
      return { status: 401, body: { ok: false } };
    }

    let event: WebhookEvent;
    try {
      const raw: unknown = JSON.parse(rawBody);
      const parsed = webhookEventSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn("[razorpay] webhook payload validation failed", { issues: parsed.error.issues });
        return { status: 400, body: { ok: false, error: "invalid payload" } };
      }
      event = parsed.data;
    } catch {
      return { status: 400, body: { ok: false, error: "invalid JSON" } };
    }

    const payment = event.payload.payment?.entity;
    if (!payment) {
      return { status: 200, body: { ok: true, ignored: event.event } };
    }

    const org = await this.findOrgFromNotes(payment.notes);

    try {
      await this.persistPayment(payment, org?.id ?? null);
    } catch (error) {
      logger.error("[razorpay] failed to persist payment", { error });
      return { status: 500, body: { ok: false } };
    }

    return { status: 200, body: { ok: true } };
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

    await this.db
      .insert(platformPayments)
      .values(fields)
      .onConflictDoUpdate({ target: platformPayments.razorpayPaymentId, set: fields });
  }

  private async findOrgFromNotes(
    notes?: Record<string, string>,
  ): Promise<{ id: string } | null> {
    if (!notes) return null;
    const slug = notes.org_slug || notes.organization_slug || notes.orgSlug;
    if (!slug) return null;
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.slug, slug),
      columns: { id: true },
    });
    return org ?? null;
  }

  getPlans() {
    const plans = [
      {
        id: "STARTER" as Plan,
        name: "Starter",
        monthlyPrice: 999,
        annualPrice: 799,
        features: ["HR module", "Up to 25 employees", "Basic payroll", "Leave management"],
        maxEmployees: 25,
      },
      {
        id: "PROFESSIONAL" as Plan,
        name: "Professional",
        monthlyPrice: 1999,
        annualPrice: 1599,
        features: ["All Starter features", "Up to 200 employees", "Performance management", "Advanced analytics", "CRM module"],
        maxEmployees: 200,
      },
      {
        id: "ENTERPRISE" as Plan,
        name: "Enterprise",
        monthlyPrice: 3999,
        annualPrice: 3199,
        features: ["All Professional features", "Unlimited employees", "Custom integrations", "Dedicated support", "All modules"],
        maxEmployees: null,
      },
    ];
    return { plans };
  }

  getMarketplace() {
    return { apps: [], addons: [] };
  }

  async purchaseAddon(orgId: string, _userId: string, addonId: string, quantity: number) {
    if (addonId.startsWith("ai_pack_")) {
      const packId = parseInt(addonId.replace("ai_pack_", ""), 10);
      const packs = await this.aiCredits.listPacks();
      const pack = packs.find((p) => p.id === packId);
      if (!pack) throw new BadRequestException("AI credit pack not found");
      return this.razorpay.createOrder({
        amount: pack.priceInPaise * quantity,
        receipt: `ai_pack_${packId}_${orgId}`,
        notes: {
          orgId: String(orgId),
          packId: String(packId),
          quantity: String(quantity),
        },
      });
    }
    throw new BadRequestException("Unknown addon type");
  }

  async getBillingProfile(orgId: string) {
    const numericOrgId = parseInt(orgId, 10);
    const [existing] = await this.db
      .select()
      .from(billingProfiles)
      .where(eq(billingProfiles.orgId, numericOrgId));
    if (existing) return existing;
    const [profile] = await this.db
      .insert(billingProfiles)
      .values({ orgId: numericOrgId })
      .returning();
    return profile;
  }

  async updateBillingProfile(orgId: string, data: UpdateBillingProfileInput) {
    await this.getBillingProfile(orgId);
    const numericOrgId = parseInt(orgId, 10);
    const [updated] = await this.db
      .update(billingProfiles)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(billingProfiles.orgId, numericOrgId))
      .returning();
    return updated;
  }

  async getSeatInfo(orgId: string) {
    const { subscription } = await this.getSubscription(orgId);
    const PLAN_SEATS: Record<string, number> = {
      STARTER: 10,
      PROFESSIONAL: 50,
      ENTERPRISE: 500,
    };
    const plan = subscription?.plan ?? "STARTER";
    const total = PLAN_SEATS[plan] ?? 10;
    const [usedResult] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId));
    const used = Number(usedResult?.count ?? 0);
    return { total, used, available: Math.max(0, total - used) };
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
          totalOutstanding: sql<string>`coalesce(sum(case when ${invoices.status} in ('SENT','OVERDUE') then ${invoices.total}::numeric else 0 end), 0)::text`,
          draft: sql<number>`count(case when ${invoices.status} = 'DRAFT' then 1 end)::int`,
          sent: sql<number>`count(case when ${invoices.status} = 'SENT' then 1 end)::int`,
          paid: sql<number>`count(case when ${invoices.status} = 'PAID' then 1 end)::int`,
          overdue: sql<number>`count(case when ${invoices.status} = 'OVERDUE' then 1 end)::int`,
          cancelled: sql<number>`count(case when ${invoices.status} = 'CANCELLED' then 1 end)::int`,
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
        sent: 0,
        paid: 0,
        overdue: 0,
        cancelled: 0,
      },
      isConfigured: this.razorpay.isConfigured(),
    };
  }
}
