import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { type Db } from "../../../db/drizzle.module";
import { BillingCoupons } from "./billing-coupons";
import { type BillingCycle, type Plan } from "./dto/billing.schemas";
import { PLAN_PRICES_PAISE } from "./plan-entitlements.constants";
import { VersionedCatalogService } from "./versioned-catalog.service";
import { applyDiscount, resolveQuotePrice } from "./coupon-pricing";
import { SubscriptionPurchaseService } from "./subscription-purchase.service";
import type { PlatformMerchantService } from "../payments/platform-merchant.service";

export interface BillingOrderCreationDeps {
  db: Db;
  catalog: VersionedCatalogService;
  platformMerchant: PlatformMerchantService;
  purchaseService?: SubscriptionPurchaseService;
}

export class BillingOrderCreation {
  private readonly couponAdmin: BillingCoupons;
  private readonly logger = new Logger(BillingOrderCreation.name);
  private readonly purchaseService: SubscriptionPurchaseService;

  constructor(private readonly deps: BillingOrderCreationDeps) {
    this.couponAdmin = new BillingCoupons(deps.db);
    this.purchaseService = deps.purchaseService ?? new SubscriptionPurchaseService(deps.db);
  }

  async createOrder(
    orgId: string,
    userId: string,
    plan: Plan,
    billingCycle: BillingCycle = "monthly",
    couponId?: number,
  ) {
    const platformMerchant = this.deps.platformMerchant;
    const provider = platformMerchant.resolve();
    if (!provider || !provider.isReady()) {
      throw new ServiceUnavailableException("Payment gateway not configured. Contact support.");
    }
    if (!PLAN_PRICES_PAISE[plan]) throw new BadRequestException("Invalid plan");

    const readiness = platformMerchant.readiness();
    const environment = platformMerchant.environment();
    const merchantKeyId = readiness.publicKeyId;
    if (!readiness.configured || environment === null || merchantKeyId === null) {
      throw new ServiceUnavailableException("Payment gateway not configured. Contact support.");
    }

    const price = await this.billablePrice(plan, billingCycle);
    const baseAmount = price.amount;
    let amount = baseAmount;
    let couponDiscountAmount = 0;
    let reservedCouponId: number | null = null;

    const catalogVersion = await this.deps.catalog
      .getActivePriceForPlanTier(plan)
      .then((p) => p?.id ?? null);

    if (couponId !== undefined) {
      const reservation = await this.deps.db.transaction(async (tx) => {
        return this.couponAdmin.reserve(tx, couponId, orgId, plan, baseAmount);
      });
      if (!reservation.reserved) {
        throw new BadRequestException(reservation.reason);
      }
      couponDiscountAmount = reservation.discountAmountMinor;
      amount = applyDiscount(baseAmount, couponDiscountAmount);
      reservedCouponId = couponId;
    }

    let purchase: Awaited<ReturnType<SubscriptionPurchaseService["create"]>>;
    try {
      purchase = await this.deps.db.transaction(async (tx) =>
        this.purchaseService.create(tx, {
          orgId,
          createdByUserId: userId,
          providerKey: provider.providerKey,
          environment,
          merchantKeyId,
          providerOrderId: null,
          plan,
          billingCycle,
          catalogVersion,
          baseAmountMinor: baseAmount,
          discountAmountMinor: couponDiscountAmount,
          amountMinor: amount,
          currency: price.currency,
          couponId: reservedCouponId,
        }),
      );
    } catch (err: unknown) {
      await this.releaseReservation(orgId, reservedCouponId, "purchase intent write error");
      throw err;
    }

    let providerOrderId: string;
    try {
      const result = await provider.createOrder({
        amount: String(amount),
        currency: price.currency,
        receipt: `sub_${orgId.slice(-8)}_${String(purchase.id)}`,
        notes: { orgId, plan, userId, billingCycle, purchaseId: String(purchase.id) },
      });
      providerOrderId = result.providerOrderId;
    } catch (err: unknown) {
      await this.abandonIntent(orgId, purchase.id);
      await this.releaseReservation(orgId, reservedCouponId, "order creation error");
      throw err;
    }

    try {
      const claimed = await this.deps.db.transaction(async (tx) =>
        this.purchaseService.attachProviderOrder(tx, purchase.id, orgId, providerOrderId),
      );
      if (claimed === null)
        throw new Error(
          `purchase ${purchase.id} could not be claimed for order ${providerOrderId}; it already carries an order`,
        );

      return {
        orderId: providerOrderId,
        purchaseId: purchase.id,
        amount,
        currency: price.currency,
        keyId: merchantKeyId,
        environment,
        plan,
        billingCycle,
        discountAmount: couponDiscountAmount,
      };
    } catch (err: unknown) {
      await this.releaseReservation(orgId, reservedCouponId, "purchase record write error");
      throw err;
    }
  }

  private async abandonIntent(orgId: string, purchaseId: number): Promise<void> {
    try {
      await this.deps.db.transaction(async (tx) =>
        this.purchaseService.markFailed(tx, purchaseId, orgId, {
          abandonedReason: "provider order creation failed before an order id existed",
        }),
      );
    } catch (error: unknown) {
      this.logger.error(
        `[billing] could not retire purchase intent ${String(purchaseId)} after an order-creation failure`,
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  private async releaseReservation(
    orgId: string,
    reservedCouponId: number | null,
    context: string,
  ): Promise<void> {
    if (reservedCouponId === null) return;
    await this.deps.db
      .transaction(async (tx) => {
        await this.couponAdmin.release(tx, reservedCouponId);
      })
      .catch((releaseErr: unknown) => {
        this.logger.error(`[billing] coupon reservation release failed after ${context}`, {
          orgId,
          couponId: reservedCouponId,
          releaseErr,
        });
      });
  }

  private async billablePrice(plan: Plan, billingCycle: BillingCycle) {
    const catalogPrice = await this.deps.catalog.getActivePriceForPlanTier(plan);
    return resolveQuotePrice(plan, billingCycle, catalogPrice ?? null);
  }
}
