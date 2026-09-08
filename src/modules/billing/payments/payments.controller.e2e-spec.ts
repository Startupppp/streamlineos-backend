import { NotFoundException, type INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { PaymentProviderSetupService } from "./payment-provider-setup.service";
import { PaymentTestTransactionService } from "./payment-test-transaction.service";
import { PaymentWebhookHealthService } from "./payment-webhook-health.service";
import { PaymentReadinessService } from "./payment-readiness.service";
import { PaymentAuditService } from "./payment-audit.service";
import { PaymentManualMethodsService } from "./payment-manual-methods.service";

const stubProviders = {
  getCatalog: jest.fn().mockResolvedValue([]),
  listProviders: jest.fn().mockResolvedValue([]),
  getProvider: jest.fn().mockResolvedValue({ id: 1, key: "razorpay" }),
  createProvider: jest.fn().mockResolvedValue({ id: 1 }),
  updateProvider: jest.fn().mockResolvedValue({ id: 1 }),
  disableProvider: jest.fn().mockResolvedValue(undefined),
  saveCredentials: jest.fn().mockResolvedValue(undefined),
  disconnectCredentials: jest.fn().mockResolvedValue(undefined),
};

const stubTestTransactions = {
  listForProvider: jest.fn().mockResolvedValue([]),
  createTestTransaction: jest.fn().mockResolvedValue({ id: 1 }),
  verifyTestTransaction: jest.fn().mockResolvedValue({ verified: true }),
};

const stubWebhooks = {
  generateEndpoint: jest.fn().mockResolvedValue({ url: "https://example.com/hook" }),
  verifyEndpointManual: jest.fn().mockResolvedValue({ verified: true }),
  listEvents: jest.fn().mockResolvedValue([]),
  retryEvent: jest.fn().mockResolvedValue(undefined),
};

const stubReadiness = {
  getReadiness: jest.fn().mockResolvedValue({ ready: true }),
  activateLive: jest.fn().mockResolvedValue(undefined),
};

const stubAudit = {
  listForProvider: jest.fn().mockResolvedValue([]),
  listForOrg: jest.fn().mockResolvedValue([]),
};

const stubManualMethods = {
  list: jest.fn().mockResolvedValue([]),
  create: jest.fn().mockResolvedValue({ id: 1 }),
  update: jest.fn().mockResolvedValue({ id: 1 }),
  disable: jest.fn().mockResolvedValue(undefined),
};

describe("Payments controller auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: PaymentProviderSetupService, useValue: stubProviders },
        { provide: PaymentTestTransactionService, useValue: stubTestTransactions },
        { provide: PaymentWebhookHealthService, useValue: stubWebhooks },
        { provide: PaymentReadinessService, useValue: stubReadiness },
        { provide: PaymentAuditService, useValue: stubAudit },
        { provide: PaymentManualMethodsService, useValue: stubManualMethods },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  type Method = "get" | "post" | "patch";

  function call(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get": return agent.get(path);
      case "post": return agent.post(path);
      case "patch": return agent.patch(path);
    }
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/payments/providers/catalog"],
    ["get", "/payments/providers"],
    ["post", "/payments/providers"],
    ["get", "/payments/providers/razorpay"],
    ["patch", "/payments/providers/razorpay"],
    ["post", "/payments/providers/razorpay/disable"],
    ["post", "/payments/providers/razorpay/credentials"],
    ["post", "/payments/providers/razorpay/credentials/rotate"],
    ["post", "/payments/providers/razorpay/disconnect"],
    ["get", "/payments/providers/razorpay/test-transactions"],
    ["post", "/payments/providers/razorpay/test-transactions"],
    ["get", "/payments/providers/razorpay/webhooks/events"],
    ["post", "/payments/providers/razorpay/webhooks/generate"],
    ["post", "/payments/providers/razorpay/webhooks/verify"],
    ["get", "/payments/providers/razorpay/readiness"],
    ["post", "/payments/providers/razorpay/activate-live"],
    ["get", "/payments/providers/razorpay/audit"],
    ["get", "/payments/audit"],
    ["get", "/payments/manual-methods"],
    ["post", "/payments/manual-methods"],
    ["patch", "/payments/manual-methods/1"],
    ["post", "/payments/manual-methods/1/disable"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await call(method, path);
    expect(res.status).toBe(401);
  });

  const viewGated: ReadonlyArray<[Method, string]> = [
    ["get", "/payments/providers/catalog"],
    ["get", "/payments/providers"],
    ["get", "/payments/providers/razorpay"],
    ["get", "/payments/providers/razorpay/test-transactions"],
    ["get", "/payments/providers/razorpay/webhooks/events"],
    ["get", "/payments/providers/razorpay/readiness"],
    ["get", "/payments/providers/razorpay/audit"],
    ["get", "/payments/audit"],
    ["get", "/payments/manual-methods"],
  ];

  it.each(viewGated)("403 on %s %s without payments:providers:view", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await call(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  const manageGated: ReadonlyArray<[Method, string]> = [
    ["post", "/payments/providers"],
    ["patch", "/payments/providers/razorpay"],
    ["post", "/payments/providers/razorpay/disable"],
  ];

  it.each(manageGated)("403 on %s %s for view-only holder", async (method, path) => {
    const token = await signToken({
      permissions: ["payments:providers:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await call(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 on POST /payments/providers/razorpay/credentials without payments:credentials:manage", async () => {
    const token = await signToken({
      permissions: ["payments:providers:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await call("post", "/payments/providers/razorpay/credentials")
      .set("Authorization", `Bearer ${token}`)
      .send({ environment: "test", credentials: {} });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 on POST /payments/providers/razorpay/activate-live without payments:live:activate", async () => {
    const token = await signToken({
      permissions: ["payments:providers:manage"],
      enabledModules: ALL_MODULES,
    });
    const res = await call("post", "/payments/providers/razorpay/activate-live")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 on POST /payments/manual-methods without payments:manual-methods:manage", async () => {
    const token = await signToken({
      permissions: ["payments:providers:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await call("post", "/payments/manual-methods")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Bank Transfer" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("cross-tenant: another org provider key returns 404 not 403", async () => {
    const token = await signToken({
      permissions: ["payments:providers:view"],
      enabledModules: ALL_MODULES,
    });
    stubProviders.getProvider.mockRejectedValueOnce(
      new NotFoundException("Payment provider not configured: razorpay"),
    );
    const res = await call("get", "/payments/providers/razorpay")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
