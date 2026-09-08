import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
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
  createOrder: jest.fn().mockResolvedValue({
    orderId: "order_1",
    amount: 100,
    currency: "INR",
    keyId: "key_1",
    plan: "STARTER",
    billingCycle: "monthly",
    discountAmount: 0,
  }),
  verifyAndActivate: jest.fn().mockResolvedValue({ success: true, plan: "STARTER", status: "ACTIVE" }),
  getSubscription: jest.fn().mockResolvedValue({ subscription: null, publicKeyId: null, isConfigured: false }),
  getPlans: jest.fn().mockReturnValue({ plans: [] }),
  getMarketplace: jest.fn().mockReturnValue({}),
  getSummary: jest.fn().mockResolvedValue({ isConfigured: false }),
  purchaseAddon: jest.fn().mockResolvedValue({
    orderId: "order_addon_1",
    amount: 4900,
    currency: "INR",
    keyId: "key_1",
    pack: {
      id: 1,
      name: "Starter AI Pack",
      credits: 1000,
      bonusCredits: 100,
      priceInPaise: 4900,
      isActive: true,
      sortOrder: 1,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  }),
  validateCoupon: jest.fn().mockResolvedValue(null),
  getBillingProfile: jest.fn().mockResolvedValue(null),
  updateBillingProfile: jest.fn().mockResolvedValue({
    id: 1,
    orgId: "org_1",
    gstin: null,
    pan: null,
    billingName: "Acme Inc",
    billingEmail: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    pincode: null,
    country: null,
    isTaxExempt: false,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  }),
  getSeatInfo: jest.fn().mockResolvedValue({ total: 0, used: 0, available: 0 }),
  listAddons: jest.fn().mockResolvedValue([]),
  listCoupons: jest.fn().mockResolvedValue([]),
  createCoupon: jest.fn().mockResolvedValue({
    id: 1,
    code: "SAVE10",
    type: "PERCENTAGE",
    value: "10.00",
    minPurchase: null,
    maxUses: null,
    usedCount: 0,
    isActive: true,
    applicablePlans: null,
    expiresAt: null,
    orgId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  }),
  updateCoupon: jest.fn().mockResolvedValue({
    id: 1,
    code: "SAVE10",
    type: "PERCENTAGE",
    value: "15.00",
    minPurchase: null,
    maxUses: null,
    usedCount: 0,
    isActive: true,
    applicablePlans: null,
    expiresAt: null,
    orgId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  }),
  deleteCoupon: jest.fn().mockResolvedValue({ success: true }),
  listProvisioningFailures: jest.fn().mockResolvedValue([]),
};

const stubPlanLimits = {
  getEntitlements: jest.fn().mockResolvedValue({}),
};

const stubProviderRow = {
  id: 1,
  orgId: "org_1",
  providerKey: "razorpay",
  displayName: "Razorpay",
  status: "test_mode_ready",
  environment: "test",
  isPrimary: true,
  supportedCurrencies: ["INR"],
  supportedPaymentMethods: ["card", "upi"],
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const stubProviders = {
  getCatalog: jest.fn().mockResolvedValue([]),
  listProviders: jest.fn().mockResolvedValue([]),
  getProvider: jest.fn().mockResolvedValue({ ...stubProviderRow, credentials: [] }),
  createProvider: jest.fn().mockResolvedValue({ ...stubProviderRow, status: "not_configured" }),
  updateProvider: jest.fn().mockResolvedValue(stubProviderRow),
  disableProvider: jest.fn().mockResolvedValue({ ...stubProviderRow, status: "disabled" }),
  saveCredentials: jest.fn().mockResolvedValue({
    credential: {
      environment: "test",
      maskedKeyHint: "****1234",
      hasSecret: true,
      hasWebhookSecret: false,
      lastRotatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    warning: null,
  }),
  disconnectCredentials: jest.fn().mockResolvedValue({ success: true }),
};

const stubTestTransactions = {
  listForProvider: jest.fn().mockResolvedValue([]),
  createTestTransaction: jest.fn().mockResolvedValue({
    id: 1,
    orgId: "org_1",
    providerId: 1,
    environment: "test",
    amount: "499.00",
    currency: "INR",
    status: "created",
    providerOrderId: "order_test_1",
    providerPaymentId: null,
    signatureVerified: false,
    webhookReceived: false,
    resultSummary: null,
    createdBy: "user_1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    keyId: "key_1",
  }),
  verifyTestTransaction: jest.fn().mockResolvedValue({
    id: 1,
    orgId: "org_1",
    providerId: 1,
    environment: "test",
    amount: "499.00",
    currency: "INR",
    status: "verified",
    providerOrderId: "order_test_1",
    providerPaymentId: "pay_test_1",
    signatureVerified: true,
    webhookReceived: false,
    resultSummary: null,
    createdBy: "user_1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  }),
};

const stubWebhookEndpoint = {
  id: 1,
  orgId: "org_1",
  providerId: 1,
  environment: "test",
  url: "https://example.com/hook",
  expectedEvents: ["payment.captured"],
  status: "not_verified",
  lastVerifiedAt: null,
  lastFailureAt: null,
  failureReason: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const stubWebhooks = {
  generateEndpoint: jest.fn().mockResolvedValue(stubWebhookEndpoint),
  verifyEndpointManual: jest.fn().mockResolvedValue({ ...stubWebhookEndpoint, status: "verified" }),
  listEvents: jest.fn().mockResolvedValue([]),
  retryEvent: jest.fn().mockResolvedValue(undefined),
};

const stubReadiness = {
  getReadiness: jest.fn().mockResolvedValue({ completedChecks: [], blockers: [], warnings: [], readyForLive: true }),
  activateLive: jest.fn().mockResolvedValue({ ...stubProviderRow, status: "live" }),
};

const stubAudit = {
  listForProvider: jest.fn().mockResolvedValue([]),
  listForOrg: jest.fn().mockResolvedValue([]),
};

const stubManualMethodRow = {
  id: 1,
  orgId: "org_1",
  methodType: "bank_transfer",
  displayName: "Bank Transfer",
  instructions: null,
  bankName: null,
  accountHolder: null,
  maskedAccountNumber: null,
  ifscSwiftIban: null,
  upiId: null,
  paymentReferenceInstructions: null,
  requireManualApproval: true,
  status: "enabled",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const stubManualMethods = {
  list: jest.fn().mockResolvedValue([]),
  create: jest.fn().mockResolvedValue(stubManualMethodRow),
  update: jest.fn().mockResolvedValue({ ...stubManualMethodRow, displayName: "Updated Bank Transfer" }),
  disable: jest.fn().mockResolvedValue({ ...stubManualMethodRow, status: "disabled" }),
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

type MutationCase = readonly [method: string, path: string, key: string, body: Record<string, unknown>, happyStatus: number];

const BILLING_MUTATIONS: ReadonlyArray<MutationCase> = [
  ["POST", "/billing/checkout", "billing:subscription:manage", { plan: "STARTER" }, 200],
  ["PATCH", "/billing/checkout", "billing:subscription:manage", { orderId: "order_1", paymentId: "pay_1", signature: "sig", plan: "STARTER" }, 200],
  ["POST", "/billing/addons/purchase", "billing:subscription:manage", { addonId: "ai_pack_1", quantity: 1 }, 200],
  ["PATCH", "/billing/profile", "billing:profile:update", { billingName: "Acme Inc" }, 200],
  ["POST", "/billing/coupons", "billing:coupons:manage", { code: "SAVE10", type: "PERCENTAGE", value: 10 }, 201],
  ["PATCH", "/billing/coupons/1", "billing:coupons:manage", { value: 15 }, 200],
  ["DELETE", "/billing/coupons/1", "billing:coupons:manage", {}, 200],
] as const;

const PAYMENTS_MUTATIONS: ReadonlyArray<MutationCase> = [
  ["POST", "/payments/providers", "payments:providers:manage", { providerKey: "razorpay" }, 201],
  ["PATCH", "/payments/providers/razorpay", "payments:providers:manage", { isPrimary: true }, 200],
  ["POST", "/payments/providers/razorpay/disable", "payments:providers:manage", {}, 200],
  ["POST", "/payments/providers/razorpay/credentials", "payments:credentials:manage", { environment: "test", secret: "test-secret-value-1" }, 200],
  ["POST", "/payments/providers/razorpay/credentials/rotate", "payments:credentials:manage", { environment: "test", secret: "test-secret-value-2" }, 200],
  ["POST", "/payments/providers/razorpay/disconnect", "payments:credentials:manage", { environment: "test" }, 200],
  ["POST", "/payments/providers/razorpay/test-transactions", "payments:test:run", { amount: "499.00", currency: "INR" }, 201],
  ["POST", "/payments/providers/razorpay/webhooks/generate", "payments:webhooks:manage", { environment: "test" }, 200],
  ["POST", "/payments/providers/razorpay/webhooks/verify", "payments:webhooks:manage", { environment: "test" }, 200],
  ["POST", "/payments/providers/razorpay/activate-live", "payments:live:activate", {}, 200],
  ["POST", "/payments/manual-methods", "payments:manual-methods:manage", { methodType: "bank_transfer", displayName: "Bank Transfer" }, 201],
  ["PATCH", "/payments/manual-methods/1", "payments:manual-methods:manage", { displayName: "Updated Bank Transfer" }, 200],
  ["POST", "/payments/manual-methods/1/disable", "payments:manual-methods:manage", {}, 200],
] as const;

describe("Permission catalog membership (PRD 10.10-B)", () => {
  it.each(BILLING_MUTATIONS)(
    "%s %s is gated on '%s' which exists verbatim in BILLING_PERMISSIONS",
    (_method, _path, key, _body, _happyStatus) => {
      expect(BILLING_CATALOG_KEYS.has(key)).toBe(true);
    },
  );

  it.each(PAYMENTS_MUTATIONS)(
    "%s %s is gated on '%s' which exists verbatim in PAYMENTS_PERMISSIONS",
    (_method, _path, key, _body, _happyStatus) => {
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
    if (method === "POST") return agent.post(path).set("Idempotency-Key", randomUUID());
    if (method === "PATCH") return agent.patch(path).set("Idempotency-Key", randomUUID());
    if (method === "DELETE") return agent.delete(path).set("Idempotency-Key", randomUUID());
    return agent.get(path);
  }

  describe("org owner allowed on all billing mutations", () => {
    it.each(BILLING_MUTATIONS)("owner allowed: %s %s", async (method, path, _key, body, happyStatus) => {
      const token = await signToken({ isOrgOwner: true, enabledModules: ALL_MODULES });
      const res = await call(method, path)
        .set("Authorization", `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(happyStatus);
    });
  });

  describe("holder of the permission allowed on billing mutations", () => {
    it.each(BILLING_MUTATIONS)("permission holder allowed: %s %s gated on %s", async (method, path, key, body, happyStatus) => {
      const token = await signToken({ permissions: [key], enabledModules: ALL_MODULES });
      const res = await call(method, path)
        .set("Authorization", `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(happyStatus);
    });
  });

  describe("plain member denied on all billing mutations", () => {
    it.each(BILLING_MUTATIONS)("member denied: %s %s", async (method, path, _key, body) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await call(method, path)
        .set("Authorization", `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(403);
    });
  });

  describe("org owner allowed on all payment mutations", () => {
    it.each(PAYMENTS_MUTATIONS)("owner allowed: %s %s", async (method, path, _key, body, happyStatus) => {
      const token = await signToken({ isOrgOwner: true, enabledModules: ALL_MODULES });
      const res = await call(method, path)
        .set("Authorization", `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(happyStatus);
    });
  });

  describe("plain member denied on all payment mutations", () => {
    it.each(PAYMENTS_MUTATIONS)("member denied: %s %s", async (method, path, _key, body) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await call(method, path)
        .set("Authorization", `Bearer ${token}`)
        .send(body);
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
        .set("Idempotency-Key", randomUUID())
        .send({ plan: "STARTER" });
      expect(checkoutRes.status).toBe(200);

      const revokedToken = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const confirmRes = await request(app.getHttpServer())
        .patch("/billing/checkout")
        .set("Authorization", `Bearer ${revokedToken}`)
        .set("Idempotency-Key", randomUUID())
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
      .set("Idempotency-Key", randomUUID())
      .send({ orderId: "order_1", paymentId: "pay_1", signature: "sig", plan: "STARTER" });
    expect(res.status).toBe(200);
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
