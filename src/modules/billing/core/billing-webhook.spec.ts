import { Test } from "@nestjs/testing";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async (db: { insert: unknown }, fn: (tx: { insert: unknown }) => Promise<unknown>) => fn(db),
  /*
    The webhook's duplicate-event insert opens its OWN transaction rather than
    borrowing the request's, so it takes the (db, orgId, fn) form. A partial
    module mock returns undefined for anything it forgets, which surfaces as
    "not a function" a long way from here -- so both are stubbed.
  */
  runInNewTenantTransaction: async (
    db: { insert: unknown },
    _orgId: string,
    fn: (tx: { insert: unknown }) => Promise<unknown>,
  ) => fn(db),
}));
import { DRIZZLE } from "../../../db/drizzle.constants";
import { BillingService } from "./billing.service";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
import { AiCreditsService } from "./ai-credits.service";
import { AuditService } from "../../../common/audit/audit.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { PLATFORM_PAYMENT_PROVIDER } from "./platform-payment-provider";
import { PlanLimitsService } from "./plan-limits.service";
import { PaymentProviderResolver, type OrganizationPaymentProvider } from "../payments/payment-provider-resolver.service";
import { ExternalEffectLedger, ExternalEffectLeaseBusyError } from "../../../common/outbox/external-effect-ledger";
import {

  FakeProviderAdapter,
  FAKE_WEBHOOK_SECRET,
  FAKE_VALID_WEBHOOK_SIG,
} from "../payments/testing/fake-provider-adapter";
import { PlatformPaymentRegistry } from "./platform-payment-registry";

/*
  `createOrder` picks its provider by currency now, so the service needs the
  registry too. The fake hands back whichever platform-provider double the case
  already built, so these tests keep asserting what they asserted before —
  provider SELECTION has its own coverage in `provider-selection.spec.ts`.
*/
function makeRegistry(provider: unknown) {
  return {
    forCurrency: jest.fn().mockReturnValue({ provider, isPreferred: true }),
    byProviderKey: jest.fn().mockReturnValue(provider),
    available: jest.fn().mockReturnValue({ razorpay: true, stripe: false }),
  } as unknown as PlatformPaymentRegistry;
}


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

function makeEffectLedger() {
  return {
    execute: jest.fn().mockImplementation(async (_effect: unknown, send: () => Promise<void>) => {
      await send();
      return "EXECUTED";
    }),
  };
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

/**
 * @param firstDelivery false to make the dedupe insert report the event as
 *   already recorded, which is how a replayed webhook is simulated.
 *
 * Two inserts run on this path and they take different shapes: the
 * duplicate-event guard does `.onConflictDoNothing().returning()`, and the
 * payment row does `.onConflictDoUpdate()`. `values()` therefore has to answer
 * both, or the first one to be reached fails as "not a function" and the whole
 * handler returns 500 with the real cause buried in a log line.
 */
function makeWebhookDb(firstDelivery = true) {
  const onConflictDoUpdate = jest.fn().mockResolvedValue([]);
  // An empty array means the row already existed, i.e. this is a replay.
  const returning = jest.fn().mockResolvedValue(firstDelivery ? [{ id: 1 }] : []);
  const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
  const values = jest.fn().mockReturnValue({ onConflictDoUpdate, onConflictDoNothing });
  const insert = jest.fn().mockReturnValue({ values });
  // The handler stamps `processed_at` on the event row once the effect succeeds.
  const where = jest.fn().mockResolvedValue([]);
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  return {
    query: {
      // `createOrder` reads the billing profile for the country that decides
      // currency and tax jurisdiction. Absent here, so these cases price in the
      // stated fallback rather than depending on a fixture country.
      billingProfiles: { findFirst: jest.fn().mockResolvedValue(undefined) },
      organizations: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    insert,
    update,
    _spies: { insert, values, onConflictDoUpdate, onConflictDoNothing, returning, update, set, where },
  };
}

async function buildService(
  db: unknown,
  providers: PaymentProviderResolver,
  aiCredits = makeAiCredits(),
  effectLedger = makeEffectLedger(),
): Promise<BillingService> {
  const module = await Test.createTestingModule({
    providers: [
      BillingService,
      { provide: DRIZZLE, useValue: db },
      { provide: AiCreditsService, useValue: aiCredits },
      { provide: AuditService, useValue: makeAudit() },
      { provide: PlanLimitsService, useValue: makePlanLimits() },
      { provide: PaymentProviderResolver, useValue: providers },
      { provide: ExternalEffectLedger, useValue: effectLedger },
      { provide: RevenueAnalyticsService, useValue: { recordEvent: jest.fn() } },
      /*
        The platform registry, which `createOrder` now uses to pick a provider by
        currency. These cases exercise the TENANT webhook path and never reach it,
        so it is faked minimally rather than driven.
      */
      {
        provide: PlatformPaymentRegistry,
        useValue: {
          forCurrency: jest.fn(),
          byProviderKey: jest.fn(),
          available: jest.fn().mockReturnValue({ razorpay: true, stripe: false }),
        },
      },
      /*
        The platform's own payment provider, which this spec predates. Webhooks
        here are the TENANT's, resolved through the registry above -- but
        BillingService injects the platform provider too, so the module cannot
        compile without it. Faked minimally rather than exercised.
      */
      {
        provide: PLATFORM_PAYMENT_PROVIDER,
        useValue: {
          providerKey: "razorpay",
          isConfigured: jest.fn().mockReturnValue(true),
          getPublishableKey: jest.fn().mockReturnValue("rzp_test"),
          createOrder: jest.fn(),
          fetchOrder: jest.fn(),
          verifyPaymentSignature: jest.fn().mockReturnValue(true),
          verifyWebhookSignature: jest.fn().mockReturnValue(true),
        },
      },
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

      /*
        Two rows are written per accepted webhook, not one: the duplicate-event
        guard row (`onConflictDoNothing`) and the payment row
        (`onConflictDoUpdate`). Counting bare `insert` calls alone cannot tell
        them apart, so each is asserted by the conflict clause that identifies it.
      */
      expect(db._spies.insert).toHaveBeenCalledTimes(2);
      expect(db._spies.onConflictDoNothing).toHaveBeenCalledTimes(1);
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

      // Two deliveries x two rows each -- see the note above.
      expect(db._spies.insert).toHaveBeenCalledTimes(4);
      expect(db._spies.onConflictDoUpdate).toHaveBeenCalledTimes(2);
    });

    it("uses the authenticated webhook tenant when notes omit the organisation", async () => {
      const aiCredits = makeAiCredits();
      const db = makeWebhookDb();
      const providers = makeResolver(new FakeProviderAdapter());
      const svc = await buildService(db, providers, aiCredits);

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

  describe("credit grant durability — no fire-and-forget", () => {
    it("returns 500 when the AI pack credit grant fails so the provider retries", async () => {
      const aiCredits = {
        grantPlanCredits: jest.fn().mockResolvedValue(undefined),
        grantAiPackCreditsFromWebhook: jest.fn().mockRejectedValue(new Error("db unavailable")),
      };
      const ledger = {
        execute: jest.fn().mockImplementation(async (_effect: unknown, send: () => Promise<void>) => {
          await send();
          return "EXECUTED";
        }),
      };
      const db = makeWebhookDb();
      const svc = await buildService(db, makeResolver(new FakeProviderAdapter()), aiCredits, ledger);

      const result = await svc.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(500);
      expect(result.body).toMatchObject({ ok: false });
    });

    it("returns 200 on replay without invoking the grant again", async () => {
      const aiCredits = makeAiCredits();
      const ledger = {
        execute: jest.fn().mockResolvedValue("ALREADY_SUCCEEDED"),
      };
      const db = makeWebhookDb();
      const svc = await buildService(db, makeResolver(new FakeProviderAdapter()), aiCredits, ledger);

      const result = await svc.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ ok: true });
      expect(aiCredits.grantAiPackCreditsFromWebhook).not.toHaveBeenCalled();
    });

    it("returns 503 when the grant lease is held by a concurrent attempt", async () => {
      const ledger = {
        execute: jest.fn().mockRejectedValue(new ExternalEffectLeaseBusyError("pay_test_002:pack-credit-grant")),
      };
      const db = makeWebhookDb();
      const svc = await buildService(db, makeResolver(new FakeProviderAdapter()), makeAiCredits(), ledger);

      const result = await svc.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ ok: false });
    });

    it("forged event never reaches the ledger or grant", async () => {
      const ledger = { execute: jest.fn() };
      const aiCredits = makeAiCredits();
      const db = makeWebhookDb();
      const svc = await buildService(db, makeResolver(new FakeProviderAdapter()), aiCredits, ledger);

      await svc.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, "forged-sig");

      expect(ledger.execute).not.toHaveBeenCalled();
      expect(aiCredits.grantAiPackCreditsFromWebhook).not.toHaveBeenCalled();
    });

    it("out-of-order duplicate payment event returns 200 without a second grant", async () => {
      const aiCredits = makeAiCredits();
      let callCount = 0;
      const ledger = {
        execute: jest.fn().mockImplementation(async (_effect: unknown, send: () => Promise<void>) => {
          callCount += 1;
          if (callCount === 1) {
            await send();
            return "EXECUTED";
          }
          return "ALREADY_SUCCEEDED";
        }),
      };
      const db = makeWebhookDb();
      const svc = await buildService(db, makeResolver(new FakeProviderAdapter()), aiCredits, ledger);

      const first = await svc.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);
      const second = await svc.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(aiCredits.grantAiPackCreditsFromWebhook).toHaveBeenCalledTimes(1);
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
