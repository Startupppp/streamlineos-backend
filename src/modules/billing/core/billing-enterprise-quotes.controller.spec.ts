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

const validQuoteBase = {
  id: 1,
  orgId: "org-a",
  quoteRef: "EQ-0001",
  subject: "Enterprise Deal",
  planTier: "ENTERPRISE",
  requestedSeats: 100,
  negotiatedSeats: 100,
  pricePerSeatInPaise: 100000,
  contractTermMonths: 12,
  contractTerms: null,
  status: "DRAFT",
  approverId: null,
  approvalNotes: null,
  approvedAt: null,
  sentAt: null,
  acceptedAt: null,
  rejectedAt: null,
  rejectionReason: null,
  validUntil: "2027-01-01",
  notes: null,
  dealId: null,
  clientId: null,
  createdById: "user-a",
  createdAt: now,
  updatedAt: now,
};

const validQuoteDetail = {
  ...validQuoteBase,
  totalValueInPaise: 1200000,
  deal: null,
  client: null,
  approver: null,
};

const stubQuoteListRow = {
  id: 1,
  quoteRef: "EQ-0001",
  subject: "Enterprise renewal",
  planTier: "ENTERPRISE",
  negotiatedSeats: 250,
  pricePerSeatInPaise: 48000,
  contractTermMonths: 12,
  status: "DRAFT" as const,
  validUntil: "2027-01-31",
  createdAt: new Date("2026-09-08T00:00:00.000Z"),
  dealName: null,
  clientName: null,
};

const successResponse = { success: true as const };

async function buildApp(quotesMock: object): Promise<INestApplication> {
  const ref = await Test.createTestingModule({
    controllers: [BillingEnterpriseController],
    providers: [
      { provide: APP_INTERCEPTOR, useClass: ResponseContractInterceptor },
      { provide: APP_CONFIG, useValue: { NODE_ENV: "test" } },
      { provide: BillingService, useValue: {} },
      { provide: AffiliateService, useValue: {} },
      { provide: ReferralService, useValue: {} },
      { provide: RevenueAnalyticsService, useValue: {} },
      { provide: EnterpriseQuotesService, useValue: quotesMock },
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

describe("BillingEnterpriseController — enterprise-quotes response-contract coverage", () => {
  let app: INestApplication;
  const quotesMock = {
    list: jest.fn().mockResolvedValue({
      data: [stubQuoteListRow],
      pagination: { limit: 20, hasMore: false, nextCursor: null },
    }),
    create: jest.fn().mockResolvedValue({ id: 1, quoteRef: "EQ-0001" }),
    findOne: jest.fn().mockResolvedValue(validQuoteDetail),
    submit: jest.fn().mockResolvedValue(successResponse),
    approve: jest.fn().mockResolvedValue(successResponse),
    reject: jest.fn().mockResolvedValue(successResponse),
    send: jest.fn().mockResolvedValue(successResponse),
    accept: jest.fn().mockResolvedValue(successResponse),
  };

  beforeAll(async () => {
    app = await buildApp(quotesMock);
  });
  afterAll(async () => app.close());

  it("GET /billing/enterprise-quotes → 200 and enterpriseQuoteListResponseSchema passes interceptor", async () => {
    const res = await request(app.getHttpServer()).get("/billing/enterprise-quotes");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      data: [{ id: 1, quoteRef: "EQ-0001", status: "DRAFT" }],
      pagination: { limit: 20, hasMore: false, nextCursor: null },
    });
  });

  it("POST /billing/enterprise-quotes → 201 and enterpriseQuoteCreateResponseSchema passes interceptor", async () => {
    const body = {
      subject: "Deal",
      requestedSeats: 10,
      negotiatedSeats: 10,
      pricePerSeatInPaise: 50000,
      contractTermMonths: 12,
      validUntil: "2027-01-01",
    };
    const res = await request(app.getHttpServer())
      .post("/billing/enterprise-quotes")
      .send(body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 1, quoteRef: "EQ-0001" });
  });

  it("GET /billing/enterprise-quotes/:quoteId → 200 and enterpriseQuoteDetailResponseSchema passes interceptor", async () => {
    const res = await request(app.getHttpServer()).get("/billing/enterprise-quotes/1");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 1, quoteRef: "EQ-0001" });
  });

  it("POST /billing/enterprise-quotes/:quoteId/submit → 200 and successSchema passes interceptor", async () => {
    const res = await request(app.getHttpServer()).post("/billing/enterprise-quotes/1/submit");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  it("POST /billing/enterprise-quotes/:quoteId/approve → 200 and successSchema passes interceptor", async () => {
    const res = await request(app.getHttpServer())
      .post("/billing/enterprise-quotes/1/approve")
      .send({ notes: "Looks good" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  it("POST /billing/enterprise-quotes/:quoteId/reject → 200 and successSchema passes interceptor", async () => {
    const res = await request(app.getHttpServer())
      .post("/billing/enterprise-quotes/1/reject")
      .send({ reason: "Price too high" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  it("POST /billing/enterprise-quotes/:quoteId/send → 200 and successSchema passes interceptor", async () => {
    const res = await request(app.getHttpServer()).post("/billing/enterprise-quotes/1/send");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  it("POST /billing/enterprise-quotes/:quoteId/accept → 200 and successSchema passes interceptor", async () => {
    const res = await request(app.getHttpServer()).post("/billing/enterprise-quotes/1/accept");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });
});
