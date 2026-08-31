import { and, eq, sql } from "drizzle-orm";
import {
  dunningAttempts,
  organizations,
  platformPayments,
  subscriptions,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { PlanLimitsService } from "./plan-limits.service";
import { forwardOnlyStatusGuard } from "./payment-status-order";
import { type PaymentWebhookPayment } from "../payments/dto/webhook.schemas";

export class BillingPaymentState {
  constructor(
    private readonly db: Db,
    private readonly planLimits: PlanLimitsService,
  ) {}

  // Forward-only: without setWhere a redelivered `authorized` reverted a captured row.
  async persistPayment(payment: PaymentWebhookPayment, orgId: string): Promise<void> {
    const fields = {
      razorpayPaymentId: payment.id,
      razorpayOrderId: payment.orderId ?? null,
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

    await runInTenantTransaction(this.db, async (tx) => {
      await tx
        .insert(platformPayments)
        .values(fields)
        .onConflictDoUpdate({
          target: platformPayments.razorpayPaymentId,
          set: {
            ...fields,
            capturedAt:
              payment.status === "captured"
                ? new Date()
                : sql`${platformPayments.capturedAt}`,
            refundedAt:
              payment.status === "refunded"
                ? new Date()
                : sql`${platformPayments.refundedAt}`,
          },
          setWhere: forwardOnlyStatusGuard(
            platformPayments.status,
            payment.status,
          ),
        });
    }, { orgId });
  }

  async findOrgFromNotes(
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

  async transitionToPastDue(orgId: string, paymentId: string): Promise<void> {
    const now = new Date();
    await runInTenantTransaction(this.db, async (tx) => {
      const [existing] = await tx
        .select({ id: subscriptions.id, metadata: subscriptions.metadata })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.orgId, orgId),
            eq(subscriptions.status, "ACTIVE"),
          ),
        )
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
    logger.info("[billing] subscription transitioned to PAST_DUE", {
      orgId,
      paymentId,
    });
  }
}
