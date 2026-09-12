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
import { type Plan } from "./dto/billing.schemas";
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

export async function grantPlanCredits(
  deps: PlanCreditsRecorderDeps,
  orgId: string,
  userId: string,
  paymentId: string,
  plan: Plan,
): Promise<void> {
  try {
    await deps.externalEffectLedger.execute({
      organizationId: orgId,
      producerEventId: paymentId,
      effectKey: `${paymentId}:plan-credit-grant`,
      effectType: "billing.plan-credit-grant",
      providerIdempotency: "NONE",
    }, () => deps.aiCredits.grantPlanCredits(orgId, plan, userId, paymentId));
  } catch (err: unknown) {
    if (err instanceof ExternalEffectLeaseBusyError) {
      logger.warn("[billing] plan credit grant already in flight", { orgId, plan });
      return;
    }
    logger.error("[billing] plan credit grant failed", { orgId, plan, err });
    throw new ServiceUnavailableException(
      "Payment recorded but credits could not be granted. The system will retry automatically.",
    );
  }
}
