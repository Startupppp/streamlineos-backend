import {
  Inject,
  Injectable,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { subscriptions } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { AiCreditsService } from "./ai-credits.service";
import { PlanLimitsService } from "./plan-limits.service";
import { ProrationLedgerService } from "./proration-ledger.service";
import { VersionedCatalogService } from "./versioned-catalog.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { PaymentProviderResolver } from "../payments/payment-provider-resolver.service";
import { PaymentWebhookHealthService } from "../payments/payment-webhook-health.service";
import { PaymentAnalyticsService } from "../payments/payment-analytics.service";
import {
  BillingWebhookHandler,
  type WebhookResult,
} from "./billing-webhook.handler";
import { BillingCoupons } from "./billing-coupons";
import {
  type BillingCycle,
  type CreateCouponInput,
  type Plan,
  type UpdateBillingProfileInput,
  type UpdateCouponInput,
  type VerifyPaymentInput,
} from "./dto/billing.schemas";
import { buildPlanCatalog, TRIAL_PLAN } from "./plan-entitlements.constants";
import { ExternalEffectLedger } from "../../../common/outbox/external-effect-ledger";
import { BillingProfileService } from "./billing-profile.service";
import { BillingMarketplace } from "./billing-marketplace";
import { BillingAccountOverview } from "./billing-account-overview";
import { BillingPaymentActivation } from "./billing-payment-activation";

@Injectable()
export class BillingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly aiCredits: AiCreditsService,
    private readonly planLimits: PlanLimitsService,
    private readonly prorationLedger: ProrationLedgerService,
    private readonly catalog: VersionedCatalogService,
    private readonly revenueAnalytics: RevenueAnalyticsService,
    private readonly providers: PaymentProviderResolver,
    private readonly externalEffectLedger: ExternalEffectLedger,
    private readonly paymentWebhooks: PaymentWebhookHealthService,
    private readonly paymentNotices: PaymentAnalyticsService,
    private readonly billingProfile: BillingProfileService,
  ) {
    this.paymentActivation = new BillingPaymentActivation({
      db: this.db,
      audit: this.audit,
      aiCredits: this.aiCredits,
      planLimits: this.planLimits,
      prorationLedger: this.prorationLedger,
      catalog: this.catalog,
      revenueAnalytics: this.revenueAnalytics,
      providers: this.providers,
      externalEffectLedger: this.externalEffectLedger,
    });
    this.couponAdmin = new BillingCoupons(this.db);
    this.webhooks = new BillingWebhookHandler({
      db: this.db,
      aiCredits: this.aiCredits,
      planLimits: this.planLimits,
      revenueAnalytics: this.revenueAnalytics,
      providers: this.providers,
      externalEffectLedger: this.externalEffectLedger,
      paymentWebhooks: this.paymentWebhooks,
      paymentNotices: this.paymentNotices,
    });
    this.marketplace = new BillingMarketplace(
      this.aiCredits,
      this.providers,
      this.paymentActivation.currencyForOrg.bind(this.paymentActivation),
    );
    this.accountOverview = new BillingAccountOverview(
      this.db,
      this.planLimits,
      this.providers,
    );
  }

  private readonly webhooks: BillingWebhookHandler;
  private readonly paymentActivation: BillingPaymentActivation;
  private readonly couponAdmin: BillingCoupons;
  private readonly marketplace: BillingMarketplace;
  private readonly accountOverview: BillingAccountOverview;
  async getSubscription(orgId: string) {
    const subscription = await this.db.query.subscriptions.findFirst({
      where: eq(subscriptions.orgId, orgId),
      with: {
        payments: {
          limit: 5,
          orderBy: (payment, { desc: descending }) => [
            descending(payment.createdAt),
          ],
        },
      },
    });

    const adapter = await this.providers.resolveConfigured(orgId);
    return {
      subscription: subscription ?? null,
      razorpayKeyId: adapter?.publicKeyId() ?? null,
      isConfigured: adapter?.isReady() ?? false,
    };
  }

  async createOrder(
    orgId: string,
    userId: string,
    plan: Plan,
    billingCycle: BillingCycle = "monthly",
    couponId?: number,
  ) {
    return this.paymentActivation.createOrder(orgId, userId, plan, billingCycle, couponId);
  }

  async verifyAndActivate(
    orgId: string,
    userId: string,
    input: VerifyPaymentInput,
  ) {
    return this.paymentActivation.verifyAndActivate(orgId, userId, input);
  }

  validateCoupon(code: string, orgId: string, plan: Plan) {
    return this.couponAdmin.validate(code, orgId, plan);
  }

  listCoupons() {
    return this.couponAdmin.list();
  }

  createCoupon(data: CreateCouponInput) {
    return this.couponAdmin.create(data);
  }

  updateCoupon(id: number, data: UpdateCouponInput) {
    return this.couponAdmin.update(id, data);
  }

  deleteCoupon(id: number) {
    return this.couponAdmin.remove(id);
  }


  handlePaymentProviderWebhook(
    orgId: string,
    providerKey: string,
    rawBody: string,
    signature: string,
  ): Promise<WebhookResult> {
    return this.webhooks.handle(orgId, providerKey, rawBody, signature);
  }

  handleRazorpayWebhook(
    orgId: string,
    rawBody: string,
    signature: string,
  ): Promise<WebhookResult> {
    return this.webhooks.handle(orgId, "razorpay", rawBody, signature);
  }

  listProvisioningFailures(orgId: string) {
    return this.webhooks.listProvisioningFailures(orgId);
  }

  getPlans() {
    return { plans: buildPlanCatalog(), trialPlan: TRIAL_PLAN };
  }

  getMarketplace() {
    return this.marketplace.getMarketplace();
  }

  async purchaseAddon(orgId: string, addonId: string, quantity: number) {
    return this.marketplace.purchaseAddon(orgId, addonId, quantity);
  }

  async getBillingProfile(orgId: string) {
    return this.billingProfile.get(orgId);
  }

  async updateBillingProfile(orgId: string, data: UpdateBillingProfileInput) {
    return this.billingProfile.update(orgId, data);
  }


  listAddons() {
    return this.marketplace.listAddons();
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
    return this.accountOverview.getSeatInfo(orgId);
  }

  async requestAffiliatePayoutRequest(orgId: string) {
    return this.accountOverview.requestAffiliatePayoutRequest(orgId);
  }

  async getSummary(orgId: string) {
    return this.accountOverview.getSummary(orgId);
  }
}
