import type { INestApplication, CanActivate, ExecutionContext } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { APP_INTERCEPTOR } from "@nestjs/core";
import request from "supertest";
import type { Request } from "express";
import { BillingEnterpriseController } from "./billing-enterprise.controller";
import { BillingAccountOverview } from "./billing-account-overview";
import { AffiliateService } from "./affiliate.service";
import { ReferralService } from "./referral.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { EnterpriseQuotesService } from "./enterprise-quotes.service";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { ResponseContractInterceptor } from "../../../common/openapi/response-contract.interceptor";
import { APP_CONFIG } from "../../../config/config.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const TEST_USER: CurrentUserContext = {
  userId: "user-a",
  orgId: "org-a",
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "session-a",
  tokenScopes: null,
  principal: { kind: "human-session", membershipId: 1, isOrgOwner: true },
};

class MockJwtAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { user: CurrentUserContext }>();
    req.user = TEST_USER;
    return true;
  }
}

class MockPermissionGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

const validMetrics = {
  mrr: 10,
  arr: 120,
  arpu: 50,
  churnRate: 0.05,
  activeSubscriptions: 5,
  trialSubscriptions: 2,
  ltv: 500,
  cac: 100,
  expansionRevenue: 20,
  trialConversionRate: 0.3,
  refundRate: 0.01,
};

describe("BillingEnterpriseController analytics organization scope", () => {
  let app: INestApplication;
  const analytics = {
    getMetrics: jest.fn().mockResolvedValue(validMetrics),
    getTimeSeriesData: jest.fn().mockResolvedValue([]),
  };

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      controllers: [BillingEnterpriseController],
      providers: [
        { provide: APP_INTERCEPTOR, useClass: ResponseContractInterceptor },
        { provide: APP_CONFIG, useValue: { NODE_ENV: "test" } },
        { provide: BillingAccountOverview, useValue: {} },
        { provide: AffiliateService, useValue: {} },
        { provide: ReferralService, useValue: {} },
        { provide: RevenueAnalyticsService, useValue: analytics },
        { provide: EnterpriseQuotesService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(new MockJwtAuthGuard())
      .overrideGuard(PermissionGuard)
      .useValue(new MockPermissionGuard())
      .compile();

    app = ref.createNestApplication();
    await app.init();
  });

  afterAll(async () => app.close());

  it("passes the authenticated organization to every analytics read and satisfies analyticsResponseSchema through the interceptor", async () => {
    analytics.getMetrics.mockClear();
    analytics.getTimeSeriesData.mockClear();

    const res = await request(app.getHttpServer())
      .get("/billing/analytics?period=12m");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ metrics: { mrr: 10 }, timeSeries: [] });
    expect(analytics.getMetrics).toHaveBeenCalledWith("org-a");
    expect(analytics.getTimeSeriesData).toHaveBeenCalledWith("12m", "org-a");
  });
});
