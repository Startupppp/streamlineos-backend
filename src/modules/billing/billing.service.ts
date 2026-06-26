import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import {
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
import {
  webhookEventSchema,
  type Plan,
  type RazorpayPayment,
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

  async createOrder(orgId: string, userId: string, plan: Plan) {
    if (!this.razorpay.isConfigured()) {
      throw new ServiceUnavailableException("Payment gateway not configured. Contact support.");
    }

    const amount = PLAN_PRICES[plan];
    if (!amount) throw new BadRequestException("Invalid plan");

    const order = await this.razorpay.createOrder({
      amount,
      receipt: `sub_${orgId}_${Date.now()}`,
      notes: { orgId, plan, userId },
    });

    return {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: this.razorpay.getKeyId(),
      plan,
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
}
