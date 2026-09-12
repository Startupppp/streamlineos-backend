import { and, eq, inArray, lte } from "drizzle-orm";
import { subscriptionPurchases } from "../../../db/schema";
import type { SubscriptionPurchase, SubscriptionPurchaseStatus } from "../../../db/schema/billing/subscription-purchases";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type { Db } from "../../../db/drizzle.module";
import type { Plan } from "./dto/billing.schemas";

const PENDING_TTL_MINUTES = 30;

export interface CreatePurchaseInput {
  orgId: string;
  createdByUserId: string | null;
  providerKey: string;
  environment: string;
  merchantKeyId: string;
  providerOrderId: string;
  plan: Plan;
  billingCycle: string;
  catalogVersion: number | null;
  baseAmountMinor: number;
  discountAmountMinor: number;
  amountMinor: number;
  currency: string;
  couponId: number | null;
}

export interface MarkActivatedInput {
  paymentId: string;
  capturedAmountMinor: number;
  capturedCurrency: string;
  subscriptionId: number;
  activatedAt: Date;
}

export class SubscriptionPurchaseService {
  constructor(private readonly db: Db) {}

  async create(tx: DbOrTx, input: CreatePurchaseInput): Promise<SubscriptionPurchase> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PENDING_TTL_MINUTES * 60 * 1000);
    const [row] = await tx
      .insert(subscriptionPurchases)
      .values({
        orgId: input.orgId,
        createdByUserId: input.createdByUserId,
        providerKey: input.providerKey,
        environment: input.environment,
        merchantKeyId: input.merchantKeyId,
        providerOrderId: input.providerOrderId,
        plan: input.plan,
        billingCycle: input.billingCycle,
        catalogVersion: input.catalogVersion,
        baseAmountMinor: input.baseAmountMinor,
        discountAmountMinor: input.discountAmountMinor,
        amountMinor: input.amountMinor,
        currency: input.currency,
        couponId: input.couponId,
        status: "PENDING",
        expiresAt,
      })
      .returning();
    return row;
  }

  async findByOrderId(executor: DbOrTx, providerOrderId: string): Promise<SubscriptionPurchase | null> {
    const [row] = await executor
      .select()
      .from(subscriptionPurchases)
      .where(eq(subscriptionPurchases.providerOrderId, providerOrderId))
      .limit(1);
    return row ?? null;
  }

  async lockForActivation(
    tx: DbOrTx,
    purchaseId: number,
    orgId: string,
  ): Promise<SubscriptionPurchase | null> {
    const [row] = await tx
      .select()
      .from(subscriptionPurchases)
      .where(
        and(
          eq(subscriptionPurchases.id, purchaseId),
          eq(subscriptionPurchases.orgId, orgId),
        ),
      )
      .for("update")
      .limit(1);
    return row ?? null;
  }

  async markActivated(
    tx: DbOrTx,
    purchaseId: number,
    orgId: string,
    input: MarkActivatedInput,
  ): Promise<SubscriptionPurchase | null> {
    const activatableStatuses: SubscriptionPurchaseStatus[] = [
      "PENDING",
      "CAPTURED",
      "EXPIRED",
      "CANCELLED",
    ];
    const [row] = await tx
      .update(subscriptionPurchases)
      .set({
        status: "ACTIVATED",
        providerPaymentId: input.paymentId,
        capturedAmountMinor: input.capturedAmountMinor,
        capturedCurrency: input.capturedCurrency,
        subscriptionId: input.subscriptionId,
        activatedAt: input.activatedAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(subscriptionPurchases.id, purchaseId),
          eq(subscriptionPurchases.orgId, orgId),
          inArray(subscriptionPurchases.status, activatableStatuses),
        ),
      )
      .returning();
    return row ?? null;
  }

  async markFailed(
    tx: DbOrTx,
    purchaseId: number,
    orgId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await tx
      .update(subscriptionPurchases)
      .set({
        status: "FAILED",
        metadata,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(subscriptionPurchases.id, purchaseId),
          eq(subscriptionPurchases.orgId, orgId),
        ),
      );
  }

  async markCancelled(tx: DbOrTx, purchaseId: number, orgId: string): Promise<void> {
    await tx
      .update(subscriptionPurchases)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(
        and(
          eq(subscriptionPurchases.id, purchaseId),
          eq(subscriptionPurchases.orgId, orgId),
          inArray(subscriptionPurchases.status, ["PENDING", "CAPTURED"]),
        ),
      );
  }

  async expirePending(tx: DbOrTx, orgId: string, before: Date): Promise<number> {
    const rows = await tx
      .update(subscriptionPurchases)
      .set({ status: "EXPIRED", updatedAt: new Date() })
      .where(
        and(
          eq(subscriptionPurchases.orgId, orgId),
          eq(subscriptionPurchases.status, "PENDING"),
          lte(subscriptionPurchases.expiresAt, before),
        ),
      )
      .returning({ id: subscriptionPurchases.id });
    return rows.length;
  }
}
