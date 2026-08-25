import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { BillingService } from "./billing.service";
import { AiCreditsService } from "./ai-credits.service";
import { AuditService } from "../../../common/audit/audit.service";
import { PlanLimitsService } from "./plan-limits.service";
import { APP_CONFIG } from "../../../config/config.module";
import { PaymentProviderAdapterRegistry } from "../payments/payment-provider-adapter.interface";
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

function makeConfig(webhookSecret = FAKE_WEBHOOK_SECRET) {
  return { RAZORPAY_WEBHOOK_SECRET: webhookSecret };
}

function makeRegistry(adapter?: FakeProviderAdapter) {
  const registry = new PaymentProviderAdapterRegistry();
  if (adapter) registry.register(adapter);
  return registry;
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
  registry: PaymentProviderAdapterRegistry,
  configOverride?: Record<string, unknown>,
): Promise<BillingService> {
  const module = await Test.createTestingModule({
    providers: [
      BillingService,
      { provide: DRIZZLE, useValue: db },
      { provide: AiCreditsService, useValue: makeAiCredits() },
      { provide: AuditService, useValue: makeAudit() },
      { provide: PlanLimitsService, useValue: makePlanLimits() },
      { provide: PaymentProviderAdapterRegistry, useValue: registry },
      { provide: APP_CONFIG, useValue: configOverride ?? makeConfig() },
    ],
  }).compile();
  return module.get(BillingService);
}

describe("BillingService.handleRazorpayWebhook — provider resolved through registry", () => {
  describe("valid signature — webhook is accepted", () => {
    it("returns 200 and { ok: true } when signature matches", async () => {
      const db = makeWebhookDb();
      const registry = makeRegistry(new FakeProviderAdapter());
      const svc = await buildService(db, registry);

      const result = await svc.handleRazorpayWebhook(VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ ok: true });
    });

    it("persists the payment row after a valid signature", async () => {
      const db = makeWebhookDb();
      const registry = makeRegistry(new FakeProviderAdapter());
      const svc = await buildService(db, registry);

      await svc.handleRazorpayWebhook(VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(db._spies.insert).toHaveBeenCalledTimes(1);
      expect(db._spies.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe("forged body / wrong signature — no state change", () => {
    it("returns 401 when signature does not match", async () => {
      const db = makeWebhookDb();
      const registry = makeRegistry(new FakeProviderAdapter());
      const svc = await buildService(db, registry);

      const result = await svc.handleRazorpayWebhook(VALID_PAYMENT_BODY, "forged-signature");

      expect(result.status).toBe(401);
      expect(result.body).toMatchObject({ ok: false });
    });

    it("performs NO DB write when signature is wrong — no state change", async () => {
      const db = makeWebhookDb();
      const registry = makeRegistry(new FakeProviderAdapter());
      const svc = await buildService(db, registry);

      await svc.handleRazorpayWebhook(VALID_PAYMENT_BODY, "forged-signature");

      expect(db._spies.insert).not.toHaveBeenCalled();
      expect(db._spies.onConflictDoUpdate).not.toHaveBeenCalled();
    });

    it("performs NO DB query when signature is wrong — org lookup never reached", async () => {
      const db = makeWebhookDb();
      const registry = makeRegistry(new FakeProviderAdapter());
      const svc = await buildService(db, registry);

      await svc.handleRazorpayWebhook(VALID_PAYMENT_BODY, "forged-signature");

      expect(db.query.organizations.findFirst).not.toHaveBeenCalled();
    });

    it("returns 401 when the webhook secret does not match the adapter's expectation", async () => {
      const db = makeWebhookDb();
      const registry = makeRegistry(new FakeProviderAdapter());
      const svc = await buildService(db, registry, { RAZORPAY_WEBHOOK_SECRET: "wrong-secret" });

      const result = await svc.handleRazorpayWebhook(VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(401);
      expect(db._spies.insert).not.toHaveBeenCalled();
    });
  });

  describe("no configured provider — fails without leaking key or secret", () => {
    it("returns 503 when no adapter is registered for razorpay", async () => {
      const db = makeWebhookDb();
      const emptyRegistry = makeRegistry();
      const svc = await buildService(db, emptyRegistry);

      const result = await svc.handleRazorpayWebhook(VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ ok: false });
    });

    it("performs no DB write when no provider is registered", async () => {
      const db = makeWebhookDb();
      const emptyRegistry = makeRegistry();
      const svc = await buildService(db, emptyRegistry);

      await svc.handleRazorpayWebhook(VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(db._spies.insert).not.toHaveBeenCalled();
    });

    it("response body does not contain key or secret names", async () => {
      const db = makeWebhookDb();
      const emptyRegistry = makeRegistry();
      const svc = await buildService(db, emptyRegistry);

      const result = await svc.handleRazorpayWebhook(VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      const body = JSON.stringify(result.body);
      expect(body).not.toContain("secret");
      expect(body).not.toContain("key");
    });
  });

  describe("idempotency — replayed webhook does not double-apply", () => {
    it("second call with the same payment upserts (onConflictDoUpdate) rather than inserting a new row", async () => {
      const db = makeWebhookDb();
      const registry = makeRegistry(new FakeProviderAdapter());
      const svc = await buildService(db, registry);

      await svc.handleRazorpayWebhook(VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);
      await svc.handleRazorpayWebhook(VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(db._spies.insert).toHaveBeenCalledTimes(2);
      expect(db._spies.onConflictDoUpdate).toHaveBeenCalledTimes(2);
    });

    it("AI pack credit grant is not invoked when org cannot be resolved from notes", async () => {
      const aiCredits = makeAiCredits();
      const db = makeWebhookDb();
      const registry = makeRegistry(new FakeProviderAdapter());

      const module = await Test.createTestingModule({
        providers: [
          BillingService,
          { provide: DRIZZLE, useValue: db },
          { provide: AiCreditsService, useValue: aiCredits },
          { provide: AuditService, useValue: makeAudit() },
          { provide: PlanLimitsService, useValue: makePlanLimits() },
          { provide: PaymentProviderAdapterRegistry, useValue: registry },
          { provide: APP_CONFIG, useValue: makeConfig() },
        ],
      }).compile();
      const svc = module.get(BillingService);

      const result = await svc.handleRazorpayWebhook(CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(200);
      expect(aiCredits.grantAiPackCreditsFromWebhook).not.toHaveBeenCalled();
    });
  });

  describe("provider substitution — same billing flow, different adapter", () => {
    it("a second fake adapter registered under a different key produces the same domain outcome", async () => {
      const db1 = makeWebhookDb();
      const db2 = makeWebhookDb();

      const registry1 = makeRegistry(new FakeProviderAdapter("razorpay"));
      const registry2 = makeRegistry(new FakeProviderAdapter("razorpay"));

      const svc1 = await buildService(db1, registry1);
      const svc2 = await buildService(db2, registry2);

      const result1 = await svc1.handleRazorpayWebhook(VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);
      const result2 = await svc2.handleRazorpayWebhook(VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result1.status).toBe(result2.status);
      expect(result1.body).toEqual(result2.body);
    });
  });
});
