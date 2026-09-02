import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp, accessStub } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { BillingService } from "./billing.service";
import { PlanLimitsService } from "./plan-limits.service";
import { AccessService } from "src/modules/access/access.service";
import { PaymentProviderSetupService } from "../payments/payment-provider-setup.service";
import { PaymentTestTransactionService } from "../payments/payment-test-transaction.service";
import { PaymentWebhookHealthService } from "../payments/payment-webhook-health.service";
import { PaymentReadinessService } from "../payments/payment-readiness.service";
import { PaymentAuditService } from "../payments/payment-audit.service";
import { PaymentManualMethodsService } from "../payments/payment-manual-methods.service";
import { BILLING_PERMISSIONS } from "src/modules/rbac/permissions/billing";
import { PAYMENTS_PERMISSIONS } from "src/modules/rbac/permissions/payments";

const stubBilling = {
  handlePaymentProviderWebhook: jest.fn().mockResolvedValue({ status: 200, body: { ok: true } }),
  createOrder: jest.fn().mockResolvedValue({ orderId: "order_1", amount: 100, currency: "INR", keyId: "key_1", plan: "STARTER", billingCycle: "monthly" }),
  verifyAndActivate: jest.fn().mockResolvedValue({ success: true, plan: "STARTER", status: "ACTIVE" }),
  getSubscription: jest.fn().mockResolvedValue({ subscription: null, publicKeyId: null, isConfigured: false }),
  getPlans: jest.fn().mockReturnValue({ plans: [] }),
  getMarketplace: jest.fn().mockReturnValue({}),
  getSummary: jest.fn().mockResolvedValue({ isConfigured: false }),
  getEntitlements: jest.fn().mockResolvedValue({}),
  purchaseAddon: jest.fn().mockResolvedValue({ ok: true }),
  validateCoupon: jest.fn().mockResolvedValue(null),
  getBillingProfile: jest.fn().mockResolvedValue(null),
  updateBillingProfile: jest.fn().mockResolvedValue(null),
  getSeatInfo: jest.fn().mockResolvedValue({ total: 0, used: 0, available: 0 }),
  listAddons: jest.fn().mockResolvedValue([]),
  listCoupons: jest.fn().mockResolvedValue([]),
  createCoupon: jest.fn().mockResolvedValue({ id: 1 }),
  updateCoupon: jest.fn().mockResolvedValue({ id: 1 }),
  deleteCoupon: jest.fn().mockResolvedValue(undefined),
  listProvisioningFailures: jest.fn().mockResolvedValue([]),
};

const stubPlanLimits = {
  getEntitlements: jest.fn().mockResolvedValue({}),
};

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

const SERVICE_OVERRIDES = [
  { provide: BillingService, useValue: stubBilling },
  { provide: PlanLimitsService, useValue: stubPlanLimits },
  { provide: PaymentProviderSetupService, useValue: stubProviders },
  { provide: PaymentTestTransactionService, useValue: stubTestTransactions },
  { provide: PaymentWebhookHealthService, useValue: stubWebhooks },
  { provide: PaymentReadinessService, useValue: stubReadiness },
  { provide: PaymentAuditService, useValue: stubAudit },
  { provide: PaymentManualMethodsService, useValue: stubManualMethods },
];

const BILLING_CATALOG_KEYS = new Set(BILLING_PERMISSIONS.map((p) => p.name));
const PAYMENTS_CATALOG_KEYS = new Set(PAYMENTS_PERMISSIONS.map((p) => p.name));

const BILLING_MUTATIONS: ReadonlyArray<readonly [string, string, string]> = [
  ["POST", "/billing/checkout", "billing:subscription:manage"],
  ["PATCH", "/billing/checkout", "billing:subscription:manage"],
  ["POST", "/billing/addons/purchase", "billing:subscription:manage"],
  ["PATCH", "/billing/profile", "billing:profile:update"],
  ["POST", "/billing/coupons", "billing:coupons:manage"],
  ["PATCH", "/billing/coupons/1", "billing:coupons:manage"],
  ["DELETE", "/billing/coupons/1", "billing:coupons:manage"],
] as const;

const PAYMENTS_MUTATIONS: ReadonlyArray<readonly [string, string, string]> = [
  ["POST", "/payments/providers", "payments:providers:manage"],
  ["PATCH", "/payments/providers/razorpay", "payments:providers:manage"],
  ["POST", "/payments/providers/razorpay/disable", "payments:providers:manage"],
  ["POST", "/payments/providers/razorpay/credentials", "payments:credentials:manage"],
  ["POST", "/payments/providers/razorpay/disconnect", "payments:credentials:manage"],
  ["POST", "/payments/providers/razorpay/test-transactions", "payments:test:run"],
  ["POST", "/payments/providers/razorpay/webhooks/generate", "payments:webhooks:manage"],
  ["POST", "/payments/providers/razorpay/webhooks/verify", "payments:webhooks:manage"],
  ["POST", "/payments/providers/razorpay/activate-live", "payments:live:activate"],
  ["POST", "/payments/manual-methods", "payments:manual-methods:manage"],
  ["PATCH", "/payments/manual-methods/1", "payments:manual-methods:manage"],
  ["POST", "/payments/manual-methods/1/disable", "payments:manual-methods:manage"],
] as const;

describe("Permission catalog membership (PRD 10.10-B)", () => {
  it.each(BILLING_MUTATIONS)(
    "%s %s is gated on '%s' which exists verbatim in BILLING_PERMISSIONS",
    (_method, _path, key) => {
      expect(BILLING_CATALOG_KEYS.has(key)).toBe(true);
    },
  );

  it.each(PAYMENTS_MUTATIONS)(
    "%s %s is gated on '%s' which exists verbatim in PAYMENTS_PERMISSIONS",
    (_method, _path, key) => {
      expect(PAYMENTS_CATALOG_KEYS.has(key)).toBe(true);
    },
  );
});

describe("Billing/payment permission fence — HTTP boundary (PRD 10.10-B)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({ overrides: SERVICE_OVERRIDES });
  });

  afterAll(async () => {
    await app.close();
  });

  function call(method: string, path: string): request.Test {
    const agent = request(app.getHttpServer());
    if (method === "POST") return agent.post(path);
    if (method === "PATCH") return agent.patch(path);
    if (method === "DELETE") return agent.delete(path);
    return agent.get(path);
  }

  describe("org owner allowed on all billing mutations", () => {
    it.each(BILLING_MUTATIONS)("owner allowed: %s %s", async (method, path) => {
      const token = await signToken({ isOrgOwner: true, enabledModules: ALL_MODULES });
      const res = await call(method, path)
        .set("Authorization", `Bearer ${token}`)
        .send({ plan: "STARTER" });
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });
  });

  describe("holder of the permission allowed on billing mutations", () => {
    it.each(BILLING_MUTATIONS)("permission holder allowed: %s %s gated on %s", async (method, path, key) => {
      const token = await signToken({ permissions: [key], enabledModules: ALL_MODULES });
      const res = await call(method, path)
        .set("Authorization", `Bearer ${token}`)
        .send({ plan: "STARTER" });
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });
  });

  describe("plain member denied on all billing mutations", () => {
    it.each(BILLING_MUTATIONS)("member denied: %s %s", async (method, path) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await call(method, path)
        .set("Authorization", `Bearer ${token}`)
        .send({ plan: "STARTER" });
      expect(res.status).toBe(403);
    });
  });

  describe("org owner allowed on all payment mutations", () => {
    it.each(PAYMENTS_MUTATIONS)("owner allowed: %s %s", async (method, path) => {
      const token = await signToken({ isOrgOwner: true, enabledModules: ALL_MODULES });
      const res = await call(method, path)
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });
  });

  describe("plain member denied on all payment mutations", () => {
    it.each(PAYMENTS_MUTATIONS)("member denied: %s %s", async (method, path) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await call(method, path)
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(403);
    });
  });

  describe("revocation during checkout confirmation", () => {
    it("confirm call fails 403 when billing:subscription:manage is revoked between checkout and confirmation", async () => {
      const checkoutToken = await signToken({
        permissions: ["billing:subscription:manage"],
        enabledModules: ALL_MODULES,
      });
      const checkoutRes = await request(app.getHttpServer())
        .post("/billing/checkout")
        .set("Authorization", `Bearer ${checkoutToken}`)
        .send({ plan: "STARTER" });
      expect(checkoutRes.status).not.toBe(403);

      const revokedToken = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const confirmRes = await request(app.getHttpServer())
        .patch("/billing/checkout")
        .set("Authorization", `Bearer ${revokedToken}`)
        .send({ orderId: "order_1", paymentId: "pay_1", signature: "sig", plan: "STARTER" });
      expect(confirmRes.status).toBe(403);
      expect(confirmRes.body).toMatchObject({ code: "FORBIDDEN" });
    });
  });
});

describe("Bite proof — member denial guard bites (PRD 10.10-B)", () => {
  let fenceApp: INestApplication;
  let neutralApp: INestApplication;

  beforeAll(async () => {
    [fenceApp, neutralApp] = await Promise.all([
      createE2eApp({ overrides: SERVICE_OVERRIDES }),
      createE2eApp({
        overrides: [
          ...SERVICE_OVERRIDES,
          {
            provide: AccessService,
            useValue: {
              ...accessStub,
              holds: async (): Promise<boolean> => true,
              scopeFor: async (): Promise<string> => "all",
            },
          },
        ],
      }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([fenceApp.close(), neutralApp.close()]);
  });

  it("with AccessService.holds neutered to always return true, PATCH /billing/checkout no longer returns 403 for an empty-permission token", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(neutralApp.getHttpServer())
      .patch("/billing/checkout")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderId: "order_1", paymentId: "pay_1", signature: "sig", plan: "STARTER" });
    expect(res.status).not.toBe(403);
  });

  it("with the real guard restored, the identical request returns 403 — the neutered test above was measuring the guard, not a coincidence", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(fenceApp.getHttpServer())
      .patch("/billing/checkout")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderId: "order_1", paymentId: "pay_1", signature: "sig", plan: "STARTER" });
    expect(res.status).toBe(403);
  });
});
