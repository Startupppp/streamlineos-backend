import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  dunningAttempts,
  platformPayments,
  subscriptionPayments,
  subscriptions,
} from "../../../db/schema";
import { providerWebhookEvents } from "../../../db/schema/billing/provider-webhook-events";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { StripeOutcome } from "./stripe-platform-events";
import type { StripeLedgerState } from "./stripe-webhook-decision";
import type { BillingCycle, Plan } from "./dto/billing.schemas";

/**
 * Every row a Stripe delivery may touch, behind six named operations.
 *
 * Not an abstraction for its own sake: it is what makes "a duplicate delivery
 * credits once" a statement about rows rather than about mock calls. The
 * in-memory implementation in the spec enforces the same two unique keys
 * Postgres does, so a test can count what is in the ledger afterwards instead
 * of counting how many times a jest double was invoked -- which is the same
 * assertion the bug would pass.
 *
 * The provider key is fixed to `stripe` throughout. Razorpay's deliveries go
 * through `BillingService.handlePaymentProviderWebhook`, which speaks a
 * different envelope and resolves a different credential; sharing one class
 * between them would mean branching on the provider inside every method.
 */

export const STRIPE_PROVIDER_KEY = "stripe";

export interface StripeEventRecord {
  readonly eventId: string;
  readonly eventType: string;
  readonly rawPayload: unknown;
}

export interface StripePaymentRow {
  readonly intentId: string;
  readonly chargeId: string | null;
  readonly outcome: StripeOutcome;
  readonly amountMinor: number;
  readonly amountRefundedMinor: number;
  readonly currency: string;
  readonly email: string | null;
  readonly notes: Record<string, string>;
}

export interface StripeCreditInput {
  readonly intentId: string;
  readonly plan: Plan;
  readonly billingCycle: BillingCycle;
  readonly amountMinor: number;
  readonly currency: string;
  readonly at: Date;
}

export type StripeCreditResult =
  | { readonly credited: true; readonly subscriptionId: number; readonly periodEnd: Date }
  | { readonly credited: false };

/**
 * What a redelivery of an already-seen `evt_` id means.
 *
 * `duplicate` only when the first delivery finished. A row with no
 * `processed_at` is a delivery that died partway -- a failed credit grant, a
 * process restart -- and short-circuiting it would swallow the work forever,
 * because the retry that was supposed to finish it finds the row and stops.
 * Every step downstream is separately keyed, so resuming is safe.
 */
export type StripeEventRecording = "first" | "resume" | "duplicate";

export interface StripeWebhookLedgerPort {
  recordEvent(orgId: string, event: StripeEventRecord): Promise<StripeEventRecording>;
  readState(orgId: string, intentId: string): Promise<StripeLedgerState>;
  persistPayment(orgId: string, row: StripePaymentRow): Promise<void>;
  creditSubscription(orgId: string, input: StripeCreditInput): Promise<StripeCreditResult>;
  markPastDue(orgId: string, intentId: string, at: Date): Promise<void>;
  markEventProcessed(orgId: string, eventId: string, at: Date): Promise<void>;
}

/** Months a cycle buys. Kept beside the writer that applies it. */
function advancePeriod(from: Date, billingCycle: BillingCycle): Date {
  const end = new Date(from);
  end.setMonth(end.getMonth() + (billingCycle === "annual" ? 12 : 1));
  return end;
}

@Injectable()
export class StripeWebhookLedger implements StripeWebhookLedgerPort {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The first and cheapest idempotency gate.
   *
   * Stripe retries a delivery with the SAME `evt_` id for up to three days, so
   * the unique index catches an ordinary redelivery before anything else runs.
   *
   * The target must name the tenant. Migration 0605 replaced the two-column
   * index with `(org_id, provider, provider_event_id)` — a cross-tenant DoS,
   * since one tenant could otherwise burn an event id another tenant needed.
   * This arbiter still named the old pair, which Postgres cannot infer, so
   * every money-moving delivery raised 42P10: neither deduped nor processed. Everything downstream is guarded
   * again anyway, because two DIFFERENT events can still describe one sale.
   *
   * The route is `@Public()` with no session, so no tenant transaction is open
   * and every table here is under RLS -- `app.current_org_id()` raises 42501
   * rather than returning null. The URL's orgId is this route's tenant selector
   * and is what opens the transaction.
   */
  async recordEvent(orgId: string, event: StripeEventRecord): Promise<StripeEventRecording> {
    return runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const inserted = await tx
        .insert(providerWebhookEvents)
        .values({
          orgId,
          provider: STRIPE_PROVIDER_KEY,
          providerEventId: event.eventId,
          eventType: event.eventType,
          rawPayload: event.rawPayload,
        })
        .onConflictDoNothing({
          target: [
            providerWebhookEvents.orgId,
            providerWebhookEvents.provider,
            providerWebhookEvents.providerEventId,
          ],
        })
        .returning({ id: providerWebhookEvents.id });
      if (inserted.length > 0) return "first";

      const [existing] = await tx
        .select({ processedAt: providerWebhookEvents.processedAt })
        .from(providerWebhookEvents)
        .where(
          and(
            eq(providerWebhookEvents.provider, STRIPE_PROVIDER_KEY),
            eq(providerWebhookEvents.providerEventId, event.eventId),
          ),
        )
        .limit(1);

      return existing?.processedAt ? "duplicate" : "resume";
    });
  }

  async readState(orgId: string, intentId: string): Promise<StripeLedgerState> {
    return runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const [payment] = await tx
        .select({ status: platformPayments.status, metadata: platformPayments.metadata })
        .from(platformPayments)
        .where(
          and(
            eq(platformPayments.provider, STRIPE_PROVIDER_KEY),
            eq(platformPayments.providerPaymentRef, intentId),
          ),
        )
        .limit(1);

      const [credited] = await tx
        .select({ id: subscriptionPayments.id })
        .from(subscriptionPayments)
        .where(
          and(
            eq(subscriptionPayments.orgId, orgId),
            eq(subscriptionPayments.provider, STRIPE_PROVIDER_KEY),
            eq(subscriptionPayments.providerPaymentRef, intentId),
          ),
        )
        .limit(1);

      const refunded = payment?.metadata?.amountRefundedMinor;
      return {
        recordedOutcome: toOutcome(payment?.status),
        recordedRefundMinor: typeof refunded === "number" ? refunded : 0,
        alreadyCredited: credited !== undefined,
      };
    });
  }

  /**
   * One row per intent, whatever order its events arrive in.
   *
   * Keyed on `(provider, provider_payment_ref)` -- the index `0269` created and
   * `0531` finally declared -- rather than on `razorpay_payment_id`, which a
   * Stripe payment does not have. The outcome written is the one the decision
   * already resolved against what was stored, so this never walks a status
   * backwards on a late delivery.
   */
  async persistPayment(orgId: string, row: StripePaymentRow): Promise<void> {
    const now = new Date();
    const fields = {
      provider: STRIPE_PROVIDER_KEY,
      providerPaymentRef: row.intentId,
      providerOrderRef: row.intentId,
      orgId,
      customerEmail: row.email,
      amount: row.amountMinor,
      currency: row.currency,
      status: row.outcome,
      metadata: {
        notes: row.notes,
        chargeId: row.chargeId,
        amountRefundedMinor: row.amountRefundedMinor,
      },
      capturedAt: row.outcome === "failed" ? null : now,
      refundedAt: row.outcome === "refunded" ? now : null,
    };

    await runInNewTenantTransaction(this.db, orgId, (tx) =>
      tx
        .insert(platformPayments)
        .values(fields)
        .onConflictDoUpdate({
          target: [platformPayments.provider, platformPayments.providerPaymentRef],
          targetWhere: sql`provider_payment_ref is not null`,
          set: fields,
        }),
    );
  }

  /**
   * Credits the subscription exactly once for an intent.
   *
   * The check and the write are one transaction behind an advisory lock keyed on
   * the intent, so two deliveries racing -- which is what "at least once" means
   * in practice -- serialize rather than both finding no row and both inserting.
   * `subscription_payments` has no unique index that covers the provider pair
   * (only the partial one on `razorpay_payment_id`, which a Stripe row leaves
   * null), so the lock is the constraint here, not a belt on top of one.
   */
  async creditSubscription(orgId: string, input: StripeCreditInput): Promise<StripeCreditResult> {
    return runInNewTenantTransaction(this.db, orgId, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`stripe:credit:${orgId}:${input.intentId}`}, 0))`,
      );

      const [already] = await tx
        .select({ id: subscriptionPayments.id })
        .from(subscriptionPayments)
        .where(
          and(
            eq(subscriptionPayments.orgId, orgId),
            eq(subscriptionPayments.provider, STRIPE_PROVIDER_KEY),
            eq(subscriptionPayments.providerPaymentRef, input.intentId),
          ),
        )
        .limit(1);
      if (already) return { credited: false };

      const periodEnd = advancePeriod(input.at, input.billingCycle);

      const [existing] = await tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(eq(subscriptions.orgId, orgId))
        .for("update")
        .limit(1);

      let subscriptionId: number;
      if (existing) {
        await tx
          .update(subscriptions)
          .set({
            plan: input.plan,
            status: "ACTIVE",
            provider: STRIPE_PROVIDER_KEY,
            currentPeriodStart: input.at,
            currentPeriodEnd: periodEnd,
            updatedAt: input.at,
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
            provider: STRIPE_PROVIDER_KEY,
            currentPeriodStart: input.at,
            currentPeriodEnd: periodEnd,
          })
          .returning({ id: subscriptions.id });
        subscriptionId = created.id;
      }

      await tx.insert(subscriptionPayments).values({
        orgId,
        subscriptionId,
        provider: STRIPE_PROVIDER_KEY,
        providerPaymentRef: input.intentId,
        providerOrderRef: input.intentId,
        amount: (input.amountMinor / 100).toFixed(2),
        amountPaise: input.amountMinor,
        currency: input.currency,
        status: "captured",
        paidAt: input.at,
      });

      return { credited: true, subscriptionId, periodEnd };
    });
  }

  async markPastDue(orgId: string, intentId: string, at: Date): Promise<void> {
    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const [existing] = await tx
        .select({ id: subscriptions.id, metadata: subscriptions.metadata })
        .from(subscriptions)
        .where(and(eq(subscriptions.orgId, orgId), eq(subscriptions.status, "ACTIVE")))
        .for("update")
        .limit(1);
      if (!existing) return;

      await tx
        .update(subscriptions)
        .set({
          status: "PAST_DUE",
          updatedAt: at,
          metadata: {
            ...(existing.metadata ?? {}),
            pastDueAt: at.toISOString(),
            lastFailedPaymentId: intentId,
          },
        })
        .where(eq(subscriptions.id, existing.id));

      await tx
        .insert(dunningAttempts)
        .values({
          orgId,
          subscriptionId: existing.id,
          periodStart: at,
          milestone: "D+1",
          status: "PENDING",
          providerRetryId: intentId,
        })
        .onConflictDoNothing({
          target: [
            dunningAttempts.orgId,
            dunningAttempts.subscriptionId,
            dunningAttempts.periodStart,
            dunningAttempts.milestone,
          ],
        });
    });
  }

  async markEventProcessed(orgId: string, eventId: string, at: Date): Promise<void> {
    await runInNewTenantTransaction(this.db, orgId, (tx) =>
      tx
        .update(providerWebhookEvents)
        .set({ processedAt: at })
        .where(
          and(
            eq(providerWebhookEvents.orgId, orgId),
            eq(providerWebhookEvents.provider, STRIPE_PROVIDER_KEY),
            eq(providerWebhookEvents.providerEventId, eventId),
          ),
        ),
    );
  }
}

/**
 * A stored status back into an outcome.
 *
 * Anything unrecognised reads as "nothing recorded" rather than throwing: the
 * column is free text shared with the Razorpay path, and a row written by some
 * other producer must not be able to stop a webhook being processed.
 */
function toOutcome(status: string | undefined): StripeOutcome | null {
  if (status === "captured" || status === "failed" || status === "refunded") return status;
  return null;
}
