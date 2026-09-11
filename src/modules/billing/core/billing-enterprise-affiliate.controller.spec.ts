import type { INestApplication, CanActivate, ExecutionContext } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { APP_INTERCEPTOR } from "@nestjs/core";
import request from "supertest";
import type { Request } from "express";
import { BillingEnterpriseController } from "./billing-enterprise.controller";
import { BillingService } from "./billing.service";
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

const now = new Date();

const validAffiliate = {
  id: 1,
  userId: "user-a",
  userMembershipId: 1,
  orgId: "org-a",
  referralCode: "ABCDEF1234",
  status: "ACTIVE",
  commissionType: "PERCENTAGE",
  commissionRate: 10,
  totalEarned: 0,
  totalPaid: 0,
  pendingPayout: 0,
  clickCount: 0,
  signupCount: 0,
  createdAt: now,
  updatedAt: now,
};

const validCommission = {
  id: 1,
  affiliateId: 1,
  referredOrgId: "org-b",
  subscriptionId: null,
  amountInPaise: 500,
  status: "PENDING",
  paidAt: null,
  metadata: null,
  createdAt: now,
};

const validReferral = {
  id: 1,
  referrerOrgId: "org-a",
  referrerUserId: "user-a",
  referredEmail: "referred@example.com",
  referredOrgId: null,
  referralCode: "REFCODE123456",
  status: "PENDING",
  rewardGranted: false,
  signedUpAt: null,
  activatedAt: null,
  rewardedAt: null,
  expiresAt: null,
  createdAt: now,
};

async function buildApp(
  affiliateVal: object,
  billingVal: object,
  referralVal: object,
): Promise<INestApplication> {
  const ref = await Test.createTestingModule({
    controllers: [BillingEnterpriseController],
    providers: [
      { provide: APP_INTERCEPTOR, useClass: ResponseContractInterceptor },
      { provide: APP_CONFIG, useValue: { NODE_ENV: "test" } },
      { provide: BillingService, useValue: billingVal },
      { provide: AffiliateService, useValue: affiliateVal },
      { provide: ReferralService, useValue: referralVal },
      { provide: RevenueAnalyticsService, useValue: {} },
      { provide: EnterpriseQuotesService, useValue: {} },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue(new MockJwtAuthGuard())
    .overrideGuard(PermissionGuard)
    .useValue(new MockPermissionGuard())
    .compile();
  const app = ref.createNestApplication();
  await app.init();
  return app;
}

describe("BillingEnterpriseController — affiliate routes response-contract coverage", () => {
  let app: INestApplication;
  const affiliateMock = {
    register: jest.fn().mockResolvedValue(validAffiliate),
    getDashboard: jest.fn().mockResolvedValue({ affiliate: validAffiliate, commissions: [validCommission] }),
  };
  const billingMock = {
    requestAffiliatePayoutRequest: jest.fn().mockResolvedValue({ success: true, amount: 500, message: "Payout submitted." }),
  };

  beforeAll(async () => {
    app = await buildApp(affiliateMock, billingMock, {});
  });
  afterAll(async () => app.close());

  it("POST /billing/affiliate/register → 201 and affiliateRowSchema passes interceptor", async () => {
    const res = await request(app.getHttpServer()).post("/billing/affiliate/register");
    expect(res.status).toBe(201);
  });

  it("GET /billing/affiliate → 200 and affiliateDashboardResponseSchema passes interceptor", async () => {
    const res = await request(app.getHttpServer()).get("/billing/affiliate");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ affiliate: { id: 1 } });
  });

  it("GET /billing/affiliate → 200 when service returns null (nullable schema)", async () => {
    affiliateMock.getDashboard.mockResolvedValueOnce(null);
    const res = await request(app.getHttpServer()).get("/billing/affiliate");
    expect(res.status).toBe(200);
  });

  it("POST /billing/affiliate/payout-request → 200 and affiliatePayoutResponseSchema passes interceptor", async () => {
    const res = await request(app.getHttpServer()).post("/billing/affiliate/payout-request");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, amount: 500 });
  });
});

describe("BillingEnterpriseController — referral routes response-contract coverage", () => {
  let app: INestApplication;
  const referralMock = {
    createReferral: jest.fn().mockResolvedValue(validReferral),
    listReferrals: jest.fn().mockResolvedValue([validReferral]),
  };

  beforeAll(async () => {
    app = await buildApp({}, {}, referralMock);
  });
  afterAll(async () => app.close());

  it("POST /billing/referrals → 201 and referralRowSchema passes interceptor", async () => {
    const res = await request(app.getHttpServer())
      .post("/billing/referrals")
      .send({ email: "test@example.com" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 1, status: "PENDING" });
  });

  it("GET /billing/referrals → 200 and referralListResponseSchema passes interceptor", async () => {
    const res = await request(app.getHttpServer()).get("/billing/referrals");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
