import { Test } from "@nestjs/testing";
import { jest } from "@jest/globals";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async (db: { insert: unknown }, fn: (tx: { insert: unknown }) => Promise<unknown>) => fn(db),
}));
import { DRIZZLE } from "../../../db/drizzle.constants";
import { BillingService } from "./billing.service";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
import { AiCreditsService } from "./ai-credits.service";
import { AuditService } from "../../../common/audit/audit.service";
import { PlanLimitsService } from "./plan-limits.service";
import { PaymentProviderResolver, type OrganizationPaymentProvider } from "../payments/payment-provider-resolver.service";
import {
  FakeProviderAdapter,
  FAKE_WEBHOOK_SECRET,
  FAKE_VALID_WEBHOOK_SIG,
} from "../payments/testing/fake-provider-adapter";

const VALID_PAYMENT_BODY = JSON.stringify({
  event: "payment.authorized",
  payload: {
    payment: {
      entity: {
        id: "pay_test_001",
        amount: 100000,
        currency: "INR",
        status: "authorized",
        method: "card",
        notes: {},
      },
    },
  },
});

const CAPTURE_EVENT_BODY = JSON.stringify({
  event: "payment.captured",
  payload: {
    payment: {
      entity: {
        id: "pay_test_002",
        amount: 49900,
        currency: "INR",
        status: "captured",
        method: "card",
        notes: { packId: "1" },
      },
    },
  },
});

function makeAiCredits() {
  return {
    grantPlanCredits: jest.fn().mockResolvedValue(undefined),
    grantAiPackCreditsFromWebhook: jest.fn().mockResolvedValue(undefined),
  };
}

function makeAudit() {
  return { log: jest.fn() };
}

function makePlanLimits() {
  return { bust: jest.fn(), resolveTier: jest.fn().mockResolvedValue({ plan: "STARTER" }) };
}

function makeResolver(adapter?: FakeProviderAdapter, webhookSecret = FAKE_WEBHOOK_SECRET) {
  const provider: OrganizationPaymentProvider | undefined = adapter
    ? {
        providerKey: adapter.providerKey,
        environment: "test",
        isReady: () => adapter.isReady(),
        publicKeyId: () => adapter.publicKeyId(),
        createOrder: (params) => adapter.createOrder({ ...params, keyId: "fake-public", keySecret: "fake-private" }),
        verifyPaymentSignature: (params) => adapter.verifyPaymentSignature({ ...params, keySecret: "fake-private" }),
        verifyWebhookSignature: (params) => adapter.verifyWebhookSignature({ ...params, webhookSecret }),
        normalizeWebhook: (rawBody) => adapter.normalizeWebhook(rawBody),
      }
    : undefined;
  return {
    resolve: jest.fn().mockResolvedValue(provider),
    resolveConfigured: jest.fn().mockResolvedValue(provider),
  } as unknown as PaymentProviderResolver;
}

function makeWebhookDb() {
  const onConflictDoUpdate = jest.fn().mockResolvedValue([]);
  const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = jest.fn().mockReturnValue({ values });
  return {
    query: {
      organizations: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    insert,
    _spies: { insert, values, onConflictDoUpdate },
  };
}

async function buildService(
  db: unknown,
  providers: PaymentProviderResolver,
): Promise<BillingService> {
  const module = await Test.createTestingModule({
    providers: [
      BillingService,
      { provide: DRIZZLE, useValue: db },
      { provide: AiCreditsService, useValue: makeAiCredits() },
      { provide: AuditService, useValue: makeAudit() },
      { provide: PlanLimitsService, useValue: makePlanLimits() },
      { provide: PaymentProviderResolver, useValue: providers },
    ],
  }).compile();
  return module.get(BillingService);
}

describe("BillingService payment webhook — provider resolved through registry", () => {
  describe("valid signature — webhook is accepted", () => {
    it("returns 200 and { ok: true } when signature matches", async () => {
      const db = makeWebhookDb();
      const svc = await buildService(db, makeResolver(new FakeProviderAdapter()));

      const result = await svc.handleRazorpayWebhook("org1", VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ ok: true });
    });

    it("persists the payment row after a valid signature", async () => {
      const db = makeWebhookDb();
      const svc = await buildService(db, makeResolver(new FakeProviderAdapter()));

      await svc.handleRazorpayWebhook("org1", VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(db._spies.insert).toHaveBeenCalledTimes(1);
      expect(db._spies.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe("forged body / wrong signature — no state change", () => {
    it("returns 401 when signature does not match", async () => {
      const db = makeWebhookDb();
      const svc = await buildService(db, makeResolver(new FakeProviderAdapter()));

      const result = await svc.handleRazorpayWebhook("org1", VALID_PAYMENT_BODY, "forged-signature");

      expect(result.status).toBe(401);
      expect(result.body).toMatchObject({ ok: false });
    });

    it("performs NO DB write when signature is wrong — no state change", async () => {
      const db = makeWebhookDb();
      const svc = await buildService(db, makeResolver(new FakeProviderAdapter()));

      await svc.handleRazorpayWebhook("org1", VALID_PAYMENT_BODY, "forged-signature");

      expect(db._spies.insert).not.toHaveBeenCalled();
      expect(db._spies.onConflictDoUpdate).not.toHaveBeenCalled();
    });

    it("performs NO DB query when signature is wrong — org lookup never reached", async () => {
      const db = makeWebhookDb();
      const svc = await buildService(db, makeResolver(new FakeProviderAdapter()));

      await svc.handleRazorpayWebhook("org1", VALID_PAYMENT_BODY, "forged-signature");

      expect(db.query.organizations.findFirst).not.toHaveBeenCalled();
    });

    it("returns 401 when the webhook secret does not match the adapter's expectation", async () => {
      const db = makeWebhookDb();
      const svc = await buildService(db, makeResolver(new FakeProviderAdapter(), "wrong-secret"));

      const result = await svc.handleRazorpayWebhook("org1", VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(401);
      expect(db._spies.insert).not.toHaveBeenCalled();
    });
  });

  describe("no configured provider — fails without leaking key or secret", () => {
    it("returns 503 when no adapter is registered for razorpay", async () => {
      const db = makeWebhookDb();
      const svc = await buildService(db, makeResolver());

      const result = await svc.handleRazorpayWebhook("org1", VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ ok: false });
    });

    it("performs no DB write when no provider is registered", async () => {
      const db = makeWebhookDb();
      const svc = await buildService(db, makeResolver());

      await svc.handleRazorpayWebhook("org1", VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(db._spies.insert).not.toHaveBeenCalled();
    });

    it("response body does not contain key or secret names", async () => {
      const db = makeWebhookDb();
      const svc = await buildService(db, makeResolver());

      const result = await svc.handleRazorpayWebhook("org1", VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      const body = JSON.stringify(result.body);
      expect(body).not.toContain("secret");
      expect(body).not.toContain("key");
    });
  });

  describe("idempotency — replayed webhook does not double-apply", () => {
    it("second call with the same payment upserts (onConflictDoUpdate) rather than inserting a new row", async () => {
      const db = makeWebhookDb();
      const svc = await buildService(db, makeResolver(new FakeProviderAdapter()));

      await svc.handleRazorpayWebhook("org1", VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);
      await svc.handleRazorpayWebhook("org1", VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(db._spies.insert).toHaveBeenCalledTimes(2);
      expect(db._spies.onConflictDoUpdate).toHaveBeenCalledTimes(2);
    });

    it("uses the authenticated webhook tenant when notes omit the organisation", async () => {
      const aiCredits = makeAiCredits();
      const db = makeWebhookDb();
      const providers = makeResolver(new FakeProviderAdapter());

      const module = await Test.createTestingModule({
        providers: [
          BillingService,
          { provide: DRIZZLE, useValue: db },
          { provide: AiCreditsService, useValue: aiCredits },
          { provide: AuditService, useValue: makeAudit() },
          { provide: PlanLimitsService, useValue: makePlanLimits() },
          { provide: PaymentProviderResolver, useValue: providers },
        ],
      }).compile();
      const svc = module.get(BillingService);

      const result = await svc.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(200);
      expect(aiCredits.grantAiPackCreditsFromWebhook).toHaveBeenCalledWith(
        "org1",
        1,
        "pay_test_002",
      );
    });
  });

  describe("provider substitution — same billing flow, different adapter", () => {
    it("resolves the provider named by the route and produces the same domain outcome", async () => {
      const db1 = makeWebhookDb();
      const db2 = makeWebhookDb();

      const providers1 = makeResolver(new FakeProviderAdapter("razorpay"));
      const providers2 = makeResolver(new FakeProviderAdapter("stripe"));

      const svc1 = await buildService(db1, providers1);
      const svc2 = await buildService(db2, providers2);

      const result1 = await svc1.handlePaymentProviderWebhook("org1", "razorpay", VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);
      const result2 = await svc2.handlePaymentProviderWebhook("org1", "stripe", VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result1.status).toBe(result2.status);
      expect(result1.body).toEqual(result2.body);
      expect(providers1.resolve).toHaveBeenCalledWith("org1", "razorpay");
      expect(providers2.resolve).toHaveBeenCalledWith("org1", "stripe");
    });
  });
});

describe("legacy Razorpay webhook compatibility route", () => {
  it("preserves the old URL contract while delegating to the provider-neutral handler", async () => {
    const handlePaymentProviderWebhook = jest.fn().mockResolvedValue({
      status: 200,
      body: { ok: true },
    });
    const controller = new RazorpayWebhookController({
      handlePaymentProviderWebhook,
    } as unknown as BillingService);
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });

    await controller.handle(
      "org1",
      { rawBody: Buffer.from(VALID_PAYMENT_BODY) } as never,
      FAKE_VALID_WEBHOOK_SIG,
      { status } as never,
    );

    expect(handlePaymentProviderWebhook).toHaveBeenCalledWith(
      "org1",
      "razorpay",
      VALID_PAYMENT_BODY,
      FAKE_VALID_WEBHOOK_SIG,
    );
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ ok: true });
  });
});
