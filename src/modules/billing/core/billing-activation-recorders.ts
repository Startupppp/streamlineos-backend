import { BadRequestException, Logger, ServiceUnavailableException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { couponRedemptions, coupons } from "../../../db/schema";
import { type DbOrTx } from "../../../common/rbac/access-invalidate";
import { logger } from "../../../common/logger/logger.service";
import {
  ExternalEffectLedger,
  ExternalEffectLeaseBusyError,
} from "../../../common/outbox/external-effect-ledger";
import { AiCreditsService } from "./ai-credits.service";
import { type ConfirmCheckoutInput, type Plan } from "./dto/billing.schemas";
import { ProrationLedgerService } from "./proration-ledger.service";
import { VersionedCatalogService } from "./versioned-catalog.service";
import { couponDiscountPaise } from "./coupon-pricing";

export interface ProrationRecorderDeps {
  catalog: VersionedCatalogService;
  prorationLedger: ProrationLedgerService;
}

export interface PlanCreditsRecorderDeps {
  aiCredits: AiCreditsService;
  externalEffectLedger: ExternalEffectLedger;
}

export async function recordProrationForPlanChange(
  deps: ProrationRecorderDeps,
  activationLogger: Logger,
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
    deps.catalog.getActivePriceForPlanTier(existing.plan),
    deps.catalog.getActivePriceForPlanTier(newPlan),
  ]);
  if (!oldPrice || !newPrice) {
    activationLogger.error("Plan change recorded no proration line: no active price version for this tier", {
      orgId,
      subscriptionId: existing.id,
      from: existing.plan,
      to: newPlan,
      missing: !oldPrice ? existing.plan : newPlan,
    });
    return;
  }
  await deps.prorationLedger.recordPlanChange({
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
  }, tx);
}

export async function recordCouponRedemption(
  tx: DbOrTx,
  orgId: string,
  userId: string,
  couponId: number | undefined,
  amount: number,
): Promise<void> {
  if (couponId === undefined) return;
  const [lockedCoupon] = await tx.select({
    id: coupons.id,
    type: coupons.type,
    value: coupons.value,
    maxUses: coupons.maxUses,
    usedCount: coupons.usedCount,
  }).from(coupons).where(and(eq(coupons.orgId, orgId), eq(coupons.id, couponId), eq(coupons.isActive, true))).for("update").limit(1);
  if (!lockedCoupon) return;
  if (lockedCoupon.maxUses !== null && lockedCoupon.usedCount >= lockedCoupon.maxUses) {
    throw new BadRequestException("This coupon has reached its usage limit");
  }
  await tx.update(coupons).set({ usedCount: sql`${coupons.usedCount} + 1` }).where(and(eq(coupons.orgId, orgId), eq(coupons.id, couponId)));
  const discountPaise = couponDiscountPaise({
    id: lockedCoupon.id,
    type: lockedCoupon.type,
    value: lockedCoupon.value,
    maxUses: lockedCoupon.maxUses,
    usedCount: lockedCoupon.usedCount,
    applicablePlans: null,
    expiresAt: null,
  }, amount);
  await tx.insert(couponRedemptions).values({
    couponId,
    orgId,
    userId,
    amountPaise: discountPaise,
  });
}

export async function grantPlanCredits(
  deps: PlanCreditsRecorderDeps,
  orgId: string,
  userId: string,
  input: ConfirmCheckoutInput,
): Promise<void> {
  try {
    await deps.externalEffectLedger.execute({
      organizationId: orgId,
      producerEventId: input.paymentId,
      effectKey: `${input.paymentId}:plan-credit-grant`,
      effectType: "billing.plan-credit-grant",
      providerIdempotency: "NONE",
    }, () => deps.aiCredits.grantPlanCredits(orgId, input.plan, userId, input.paymentId));
  } catch (err: unknown) {
    if (err instanceof ExternalEffectLeaseBusyError) {
      logger.warn("[billing] plan credit grant already in flight", { orgId, plan: input.plan });
      return;
    }
    logger.error("[billing] plan credit grant failed", { orgId, plan: input.plan, err });
    throw new ServiceUnavailableException(
      "Payment recorded but credits could not be granted. The system will retry automatically.",
    );
  }
}
