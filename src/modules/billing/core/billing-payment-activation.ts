import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { asc, and, eq, gt } from "drizzle-orm";
import { organizationMembers, subscriptionPayments, subscriptions } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import { ExternalEffectLedger } from "../../../common/outbox/external-effect-ledger";
import { PaymentProviderResolver } from "../payments/payment-provider-resolver.service";
import { AiCreditsService } from "./ai-credits.service";
import { BillingCoupons } from "./billing-coupons";
import { type BillingCycle, type ConfirmCheckoutInput, type Plan } from "./dto/billing.schemas";
import { PlanLimitsService } from "./plan-limits.service";
import { PLATFORM_PRICE_CURRENCY } from "./plan-entitlements.constants";
import { ProrationLedgerService } from "./proration-ledger.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { classifyPlanChange } from "./revenue-events";
import { VersionedCatalogService } from "./versioned-catalog.service";
import {
  grantPlanCredits,
  recordProrationForPlanChange,
} from "./billing-activation-recorders";
import { addClampedMonths } from "./trial-subscription";
import { isUniqueViolation, isUniqueViolationOn } from "../../../common/db/postgres-error";
import { SubscriptionPurchaseService } from "./subscription-purchase.service";
import type { SubscriptionPurchase } from "../../../db/schema/billing/subscription-purchases";
import type { PlatformMerchantService } from "../payments/platform-merchant.service";
import { BillingOrderCreation } from "./billing-order-creation";

export interface BillingPaymentActivationDeps {
  db: Db;
  cache?: CacheService;
  audit: AuditService;
  aiCredits: AiCreditsService;
  planLimits: PlanLimitsService;
  prorationLedger: ProrationLedgerService;
  catalog: VersionedCatalogService;
  revenueAnalytics: RevenueAnalyticsService;
  providers: PaymentProviderResolver;
  externalEffectLedger: ExternalEffectLedger;
  platformMerchant: PlatformMerchantService;
  purchaseService?: SubscriptionPurchaseService;
}

export class BillingPaymentActivation {
  private readonly couponAdmin: BillingCoupons;
  private readonly logger = new Logger(BillingPaymentActivation.name);
  private readonly purchaseService: SubscriptionPurchaseService;
  private readonly orderCreation: BillingOrderCreation;

  constructor(private readonly deps: BillingPaymentActivationDeps) {
    this.couponAdmin = new BillingCoupons(deps.db);
    this.purchaseService = deps.purchaseService ?? new SubscriptionPurchaseService(deps.db);
    this.orderCreation = new BillingOrderCreation({
      db: deps.db,
      catalog: deps.catalog,
      platformMerchant: deps.platformMerchant,
      purchaseService: this.purchaseService,
    });
  }

  async createOrder(
    orgId: string,
    userId: string,
    plan: Plan,
    billingCycle: BillingCycle = "monthly",
    couponId?: number,
  ) {
    const adapter = this.deps.platformMerchant.resolve();
    if (adapter === undefined || !adapter.isReady()) {
      throw new ServiceUnavailableException("Payment gateway not configured. Contact support.");
    }
    return this.orderCreation.createOrder(orgId, userId, plan, billingCycle, couponId);
  }

  async verifyAndActivate(orgId: string, userId: string, input: ConfirmCheckoutInput) {
    const platformMerchant = this.deps.platformMerchant;
    const adapter = platformMerchant.resolve();
    if (adapter === undefined || !adapter.isReady()) {
      throw new ServiceUnavailableException("Payment gateway not configured. Contact support.");
    }

    const valid = adapter.verifyPaymentSignature({
      orderId: input.orderId,
      paymentId: input.paymentId,
      signature: input.signature,
    });
    if (!valid) throw new BadRequestException("Payment verification failed: invalid signature");

    const purchase = await this.purchaseService.findByOrderId(this.deps.db, input.orderId);
    if (!purchase) throw new NotFoundException("Purchase record not found");

    if (purchase.orgId !== orgId) {
      this.logger.warn("[billing] verifyAndActivate: order id belongs to a different org", {
        requestOrgId: orgId,
        purchaseOrgId: purchase.orgId,
        orderId: input.orderId,
      });
      throw new NotFoundException("Purchase record not found");
    }

    const readiness = platformMerchant.readiness();
    const currentEnv = platformMerchant.environment();
    if (
      readiness.publicKeyId === null ||
      purchase.merchantKeyId !== readiness.publicKeyId ||
      purchase.environment !== currentEnv
    ) {
      throw new BadRequestException(
        "Payment cannot be confirmed: merchant configuration has changed since this order was created",
      );
    }

    const snapshot = await adapter.fetchPayment(input.paymentId);
    if (!snapshot) {
      throw new BadRequestException("Payment not found at provider");
    }
    if (snapshot.orderId !== purchase.providerOrderId) {
      throw new BadRequestException("Payment does not match the order");
    }
    if (snapshot.status !== "captured") {
      throw new BadRequestException(
        `Payment is not captured (current status: ${snapshot.status})`,
      );
    }
    await this.checkCaptureIntegrity(orgId, purchase, snapshot.amountMinor, snapshot.currency);

    if (purchase.status === "ACTIVATED") {
      await this.recoverGrantIfNeeded(orgId, userId, purchase);
      return this.buildStoredOutcome(purchase, true);
    }

    const isLate = purchase.status === "EXPIRED" || purchase.status === "CANCELLED";

    return this.runActivationTransaction(orgId, userId, input.paymentId, purchase, isLate);
  }

  async performActivationFromWebhook(
    orgId: string,
    paymentId: string,
    capturedAmountMinor: number,
    capturedCurrency: string,
    purchase: SubscriptionPurchase,
  ) {
    await this.checkCaptureIntegrity(orgId, purchase, capturedAmountMinor, capturedCurrency);
    if (purchase.status === "ACTIVATED") {
      await this.recoverGrantIfNeeded(orgId, null, purchase);
      return this.buildStoredOutcome(purchase, true);
    }
    const isLate = purchase.status === "EXPIRED" || purchase.status === "CANCELLED";
    return this.runActivationTransaction(orgId, null, paymentId, purchase, isLate, capturedAmountMinor, capturedCurrency);
  }

  private async checkCaptureIntegrity(
    orgId: string,
    purchase: SubscriptionPurchase,
    capturedAmountMinor: number,
    capturedCurrency: string,
  ): Promise<void> {
    const readiness = this.deps.platformMerchant.readiness();
    const currentEnv = this.deps.platformMerchant.environment();
    if (
      readiness.publicKeyId === null ||
      purchase.merchantKeyId !== readiness.publicKeyId ||
      purchase.environment !== currentEnv
    ) {
      throw new BadRequestException(
        "Payment cannot be confirmed: merchant configuration has changed since this order was created",
      );
    }
    if (capturedAmountMinor !== purchase.amountMinor || capturedCurrency !== purchase.currency) {
      await this.purchaseService.markFailed(this.deps.db, purchase.id, orgId, {
        amountMismatch: {
          expected: { amountMinor: purchase.amountMinor, currency: purchase.currency },
          actual: { amountMinor: capturedAmountMinor, currency: capturedCurrency },
        },
      });
      throw new BadRequestException(
        "Payment amount does not match the order amount; activation refused",
      );
    }
  }

  private async recoverGrantIfNeeded(
    orgId: string,
    userId: string | null,
    purchase: SubscriptionPurchase,
  ): Promise<void> {
    if (!purchase.providerPaymentId) return;
    await grantPlanCredits(this.deps, orgId, userId ?? "", purchase.providerPaymentId, purchase.plan);
  }

  private async runActivationTransaction(
    orgId: string,
    userId: string | null,
    paymentId: string,
    purchase: SubscriptionPurchase,
    isLate: boolean,
    capturedAmountMinor?: number,
    capturedCurrency?: string,
  ) {
    const now = new Date();
    const billingCycle = purchase.billingCycle;
    const periodEnd = addClampedMonths(now, billingCycle === "annual" ? 12 : 1);

    const finalAmountMinor = capturedAmountMinor ?? purchase.amountMinor;
    const finalCurrency = capturedCurrency ?? purchase.currency;
    const plan = purchase.plan;

    let activatedPurchase: SubscriptionPurchase | null = null;

    try {
      activatedPurchase = await this.deps.db.transaction(async (tx): Promise<SubscriptionPurchase | null> => {
        const locked = await this.purchaseService.lockForActivation(tx, purchase.id, orgId);
        if (!locked) return null;

        if (locked.status === "ACTIVATED") return locked;

        const existing = await tx.query.subscriptions.findFirst({
          where: eq(subscriptions.orgId, orgId),
        });
        const revenue = classifyPlanChange(
          existing ? { plan: existing.plan, status: existing.status } : null,
          plan,
        );

        let subscriptionId: number;
        if (existing) {
          await recordProrationForPlanChange(this.deps, this.logger, tx, orgId, existing, plan, now);
          await tx.update(subscriptions).set({
            plan,
            status: "ACTIVE",
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            updatedAt: now,
          }).where(eq(subscriptions.id, existing.id));
          subscriptionId = existing.id;
        } else {
          const [created] = await tx.insert(subscriptions).values({
            orgId,
            plan,
            status: "ACTIVE",
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
          }).returning({ id: subscriptions.id });
          subscriptionId = created.id;
        }

        await tx.insert(subscriptionPayments).values({
          orgId,
          subscriptionId,
          razorpayPaymentId: paymentId,
          razorpayOrderId: purchase.providerOrderId,
          amountPaise: finalAmountMinor,
          currency: finalCurrency,
          status: "captured",
          paidAt: now,
          metadata: isLate ? { lateCapture: true } : undefined,
        });

        if (purchase.couponId !== null && purchase.couponId !== undefined) {
          await this.couponAdmin.redeem(tx, purchase.couponId, orgId, userId ?? "", finalAmountMinor);
        }

        if (revenue) {
          await this.deps.revenueAnalytics.emit(tx, {
            type: revenue.type,
            orgId,
            plan,
            previousPlan: revenue.previousPlan,
            mrr: revenue.mrr,
            amount: revenue.mrr,
            currency: PLATFORM_PRICE_CURRENCY,
            metadata: { paymentId, source: "verify-and-activate" },
            dedupeKey: `verify-and-activate:${paymentId}`,
          });
        }

        const activated = await this.purchaseService.markActivated(tx, purchase.id, orgId, {
          paymentId,
          capturedAmountMinor: finalAmountMinor,
          capturedCurrency: finalCurrency,
          subscriptionId,
          activatedAt: now,
        });

        if (!activated) {
          throw new ConcurrentActivationError();
        }

        return activated;
      });
    } catch (err: unknown) {
      if (err instanceof ConflictException) throw err;
      if (err instanceof ConcurrentActivationError) {
        const fresh =
          purchase.providerOrderId === null
            ? null
            : await this.purchaseService.findByOrderId(this.deps.db, purchase.providerOrderId);
        if (fresh?.status === "ACTIVATED") {
          return this.buildStoredOutcome(fresh, true);
        }
      }
      if (isUniqueViolation(err)) {
        if (isUniqueViolationOn(err, "uq_coupon_redemptions_coupon_org")) {
          throw new ConflictException("This coupon has already been used by your organization");
        }
        throw err;
      }
      throw err;
    }

    const activated: SubscriptionPurchase | null = activatedPurchase;
    if (activated !== null && activated.status === "ACTIVATED") {
      const activatedAt = activated.activatedAt;
      const wasAlreadyActivated =
        activatedAt !== null && activatedAt !== undefined && activatedAt < now;

      await this.deps.planLimits.bust(orgId);
      this.deps.audit.log({
        action: "settings.updated",
        userId: userId ?? "",
        orgId,
        targetType: "subscription",
        metadata: { plan, paymentId, isLate },
      });
      await grantPlanCredits(this.deps, orgId, userId ?? "", paymentId, plan);

      const cache = this.deps.cache;
      if (cache) {
        const bust = () => bustBillingMemberSessions(this.deps.db, cache, orgId);
        if (!registerAfterCommit(bust))
          await bust().catch((err: unknown) => {
            this.logger.error(
              "[billing] member session bust failed after plan activation",
              { orgId, error: err instanceof Error ? err.message : String(err) },
            );
          });
      }

      return {
        success: true as const,
        plan,
        billingCycle: purchase.billingCycle,
        status: "ACTIVE",
        currentPeriodEnd: periodEnd.toISOString(),
        alreadyActivated: wasAlreadyActivated,
      };
    }

    const fresh =
          purchase.providerOrderId === null
            ? null
            : await this.purchaseService.findByOrderId(this.deps.db, purchase.providerOrderId);
    if (fresh?.status === "ACTIVATED") {
      return this.buildStoredOutcome(fresh, true);
    }

    throw new ServiceUnavailableException("Activation did not complete; please retry");
  }

  private buildStoredOutcome(purchase: SubscriptionPurchase, alreadyActivated: boolean) {
    const billingCycle = purchase.billingCycle;
    const activatedAt = purchase.activatedAt ?? new Date();
    const periodEnd = addClampedMonths(activatedAt, billingCycle === "annual" ? 12 : 1);

    return {
      success: true as const,
      plan: purchase.plan,
      billingCycle: purchase.billingCycle,
      status: "ACTIVE",
      currentPeriodEnd: periodEnd.toISOString(),
      alreadyActivated,
    };
  }
}

const MEMBER_BUST_PAGE = 500;

async function bustBillingMemberSessions(
  db: Db,
  cache: CacheService,
  orgId: string,
): Promise<void> {
  let afterId = 0;
  for (;;) {
    const members = await runInNewTenantTransaction(db, orgId, (tx) =>
      tx
        .select({ membershipId: organizationMembers.id, userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.status, "ACTIVE"),
            gt(organizationMembers.id, afterId),
          ),
        )
        .orderBy(asc(organizationMembers.id))
        .limit(MEMBER_BUST_PAGE),
    );
    if (members.length === 0) return;
    await cache.invalidateMany(members.map((m) => CACHE_KEYS.userSession(m.userId)));
    const last = members[members.length - 1];
    if (!last || members.length < MEMBER_BUST_PAGE) return;
    afterId = last.membershipId;
  }
}

class ConcurrentActivationError extends Error {
  constructor() {
    super("concurrent activation: markActivated returned 0 rows");
  }
}
