import { Test, type TestingModule } from "@nestjs/testing";
import { type INestApplication, type CanActivate, type ExecutionContext } from "@nestjs/common";
import request from "supertest";
import { DiscoveryModule, Reflector } from "@nestjs/core";
import { BillingController } from "./billing.controller";
import { BillingEnterpriseController } from "./billing-enterprise.controller";
import { BillingMarketplaceController } from "./billing-marketplace.controller";
import { BillingPaymentActivation } from "./billing-payment-activation";
import { BillingCoupons } from "./billing-coupons";
import { BillingWebhookHandler } from "./billing-webhook.handler";
import { BillingMarketplace } from "./billing-marketplace";
import { BillingAccountOverview } from "./billing-account-overview";
import { BillingProfileService } from "./billing-profile.service";
import { PlanLimitsService } from "./plan-limits.service";
import { AffiliateService } from "./affiliate.service";
import { ReferralService } from "./referral.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { EnterpriseQuotesService } from "./enterprise-quotes.service";
import { MarketplaceService } from "./marketplace.service";
import { AiCreditsService } from "./ai-credits.service";
import { AiCreditsPacksService } from "./ai-credits-packs.service";
import { AiCreditsUsageService } from "./ai-credits-usage.service";
import { PaymentProviderResolver } from "../payments/payment-provider-resolver.service";
import { AccessService } from "../../access/access.service";
import { PermissionGuard } from "../../access/permission.guard";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { moduleAvailabilityResolver } from "../../../common/rbac/module-availability";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { attachTestAuthContext } from "../../../../test/helpers/module-guard-context";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const USER_CTX: CurrentUserContext = {
  userId: "u1",
  orgId: "org1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

class HeaderAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    attachTestAuthContext(ctx.switchToHttp().getRequest(), USER_CTX);
    return true;
  }
}

const billingActivation = { createOrder: jest.fn(), verifyAndActivate: jest.fn() };
const billingCoupons = { validate: jest.fn(), listRedeemable: jest.fn() };
const billingWebhook = { handle: jest.fn(), listProvisioningFailures: jest.fn() };
const billingMarketplace = { getMarketplace: jest.fn(), purchaseAddon: jest.fn(), listAddons: jest.fn() };
const billingOverview = {
  getSubscription: jest.fn(), getSummary: jest.fn(), getSeatInfo: jest.fn(),
  requestAffiliatePayoutRequest: jest.fn(),
};

const denyAll = {
  scopeFor: async (_u: CurrentUserContext, _k: string) => "none" as const,
  getModuleState: async () => true as const,
  buildModuleAvailabilityResolver: (getModuleMap: (orgId: string) => Promise<Record<string, boolean>>) =>
    moduleAvailabilityResolver(
      { isCoreModule: () => true, getModuleMap, getPlanLockedModules: async () => [] },
      { getUserDeniedModules: async () => new Set<string>() },
    ),
};

async function buildApp(): Promise<INestApplication> {
  const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [DiscoveryModule],
    controllers: [BillingController, BillingEnterpriseController, BillingMarketplaceController],
    providers: [
      { provide: BillingPaymentActivation, useValue: billingActivation },
      { provide: BillingCoupons, useValue: billingCoupons },
      { provide: BillingWebhookHandler, useValue: billingWebhook },
      { provide: BillingMarketplace, useValue: billingMarketplace },
      { provide: BillingAccountOverview, useValue: billingOverview },
      { provide: BillingProfileService, useValue: { get: jest.fn(), update: jest.fn() } },
      { provide: PlanLimitsService, useValue: { getEntitlements: jest.fn() } },
      { provide: AffiliateService, useValue: { register: jest.fn(), getDashboard: jest.fn() } },
      { provide: ReferralService, useValue: { createReferral: jest.fn(), listReferrals: jest.fn() } },
      { provide: RevenueAnalyticsService, useValue: { getMetrics: jest.fn(), getTimeSeriesData: jest.fn() } },
      { provide: EnterpriseQuotesService, useValue: { list: jest.fn(), create: jest.fn(), findOne: jest.fn(), submit: jest.fn(), approve: jest.fn(), reject: jest.fn(), send: jest.fn(), accept: jest.fn() } },
      { provide: MarketplaceService, useValue: { listApps: jest.fn(), installApp: jest.fn(), uninstallApp: jest.fn(), startAppTrial: jest.fn() } },
      { provide: AiCreditsService, useValue: { getWallet: jest.fn(), listPacks: jest.fn(), updateAutoTopUp: jest.fn(), purchaseCreditsDirectly: jest.fn() } },
      { provide: AiCreditsPacksService, useValue: { listTransactions: jest.fn() } },
      { provide: AiCreditsUsageService, useValue: { getUsage: jest.fn() } },
      { provide: PaymentProviderResolver, useValue: { resolveConfigured: jest.fn() } },
      { provide: AccessService, useValue: denyAll },
      Reflector,
      PermissionGuard,
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useClass(HeaderAuthGuard)
    .overrideGuard(RateLimitGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

const GET_ROUTES: readonly string[] = [
  "/billing/summary",
  "/billing/provisioning-failures",
  "/billing/coupons",
  "/billing/coupons/validate",
  "/billing/profile",
  "/billing/seats",
  "/billing/addons",
  "/billing/affiliate",
  "/billing/analytics",
  "/billing/enterprise-quotes",
  "/billing/ai-credits",
  "/billing/ai-credits/usage",
];

const POST_ROUTES: readonly string[] = [
  "/billing/addons/purchase",
  "/billing/affiliate/register",
  "/billing/affiliate/payout-request",
  "/billing/enterprise-quotes",
  "/billing/referrals",
  "/billing/ai-credits/auto-topup",
];

describe("Billing controllers — permission guard deny", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(GET_ROUTES)("GET %s is denied without the required billing permission (403)", async (path) => {
    const res = await request(app.getHttpServer()).get(path).set("Authorization", "Bearer token");
    expect(res.status).toBe(403);
  });

  it.each(POST_ROUTES)("POST %s is denied without the required billing permission (403)", async (path) => {
    const res = await request(app.getHttpServer()).post(path).set("Authorization", "Bearer token").send({});
    expect(res.status).toBe(403);
  });

  it("PATCH /billing/profile is denied without billing:profile:update (403)", async () => {
    const res = await request(app.getHttpServer()).patch("/billing/profile").set("Authorization", "Bearer token").send({});
    expect(res.status).toBe(403);
  });

  it("POST /billing/enterprise-quotes/*/submit is denied without billing:enterprise-quotes:create (403)", async () => {
    const quoteId = 1;
    const res = await request(app.getHttpServer()).post(`/billing/enterprise-quotes/${quoteId}/submit`).set("Authorization", "Bearer token");
    expect(res.status).toBe(403);
  });

  it("POST /billing/enterprise-quotes/*/approve is denied without billing:enterprise-quotes:approve (403)", async () => {
    const quoteId = 1;
    const res = await request(app.getHttpServer()).post(`/billing/enterprise-quotes/${quoteId}/approve`).set("Authorization", "Bearer token").send({});
    expect(res.status).toBe(403);
  });

  it("POST /billing/enterprise-quotes/*/reject is denied without billing:enterprise-quotes:approve (403)", async () => {
    const quoteId = 1;
    const res = await request(app.getHttpServer()).post(`/billing/enterprise-quotes/${quoteId}/reject`).set("Authorization", "Bearer token").send({});
    expect(res.status).toBe(403);
  });

  it("POST /billing/enterprise-quotes/*/send is denied without billing:enterprise-quotes:approve (403)", async () => {
    const quoteId = 1;
    const res = await request(app.getHttpServer()).post(`/billing/enterprise-quotes/${quoteId}/send`).set("Authorization", "Bearer token");
    expect(res.status).toBe(403);
  });

  it("POST /billing/enterprise-quotes/*/accept is denied without billing:enterprise-quotes:view (403)", async () => {
    const quoteId = 1;
    const res = await request(app.getHttpServer()).post(`/billing/enterprise-quotes/${quoteId}/accept`).set("Authorization", "Bearer token");
    expect(res.status).toBe(403);
  });

  it("POST /billing/marketplace/*/install is denied without billing:marketplace:install (403)", async () => {
    const appId = 1;
    const res = await request(app.getHttpServer()).post(`/billing/marketplace/${appId}/install`).set("Authorization", "Bearer token");
    expect(res.status).toBe(403);
  });

  it("DELETE /billing/marketplace/*/install is denied without billing:marketplace:install (403)", async () => {
    const appId = 1;
    const res = await request(app.getHttpServer()).delete(`/billing/marketplace/${appId}/install`).set("Authorization", "Bearer token");
    expect(res.status).toBe(403);
  });

  it("POST /billing/marketplace/*/trial is denied without billing:marketplace:install (403)", async () => {
    const appId = 1;
    const res = await request(app.getHttpServer()).post(`/billing/marketplace/${appId}/trial`).set("Authorization", "Bearer token");
    expect(res.status).toBe(403);
  });
});
