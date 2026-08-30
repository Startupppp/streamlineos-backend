import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async <T>(db: unknown, fn: (tx: unknown) => Promise<T>) => fn(db),
  runInNewTenantTransaction: async <T>(db: unknown, _orgId: string, fn: (tx: unknown) => Promise<T>) => fn(db),
}));
import { DRIZZLE } from "../../../db/drizzle.constants";
import { outboxEvents, platformPayments } from "../../../db/schema";
import { providerWebhookEvents } from "../../../db/schema/billing/provider-webhook-events";
import { BillingService } from "./billing.service";
import { BillingProfileService } from "./billing-profile.service";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
import { AiCreditsService } from "./ai-credits.service";
import { AuditService } from "../../../common/audit/audit.service";
import { PlanLimitsService } from "./plan-limits.service";
import { ProrationLedgerService } from "./proration-ledger.service";
import { VersionedCatalogService } from "./versioned-catalog.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { OutboxConsumerRegistry } from "../../../common/outbox/outbox-consumer.registry";
import { PaymentProviderResolver, type OrganizationPaymentProvider } from "../payments/payment-provider-resolver.service";
import { PaymentWebhookReceiverService } from "../payments/payment-webhook-receiver.service";
import { PaymentAnalyticsService } from "../payments/payment-analytics.service";
import { ExternalEffectLedger, ExternalEffectLeaseBusyError } from "../../../common/outbox/external-effect-ledger";
import {
  FakeProviderAdapter,
  FAKE_WEBHOOK_SECRET,
  FAKE_VALID_WEBHOOK_SIG,
} from "../payments/testing/fake-provider-adapter";

const dialect = new PgDialect();

const VALID_PAYMENT_BODY = JSON.stringify({
  event: "payment.authorized",
  payload: {
    payment: {
      entity: { id: "pay_test_001", amount: 100000, currency: "INR", status: "authorized", method: "card", notes: {} },
    },
  },
});

const CAPTURE_EVENT_BODY = JSON.stringify({
  event: "payment.captured",
  payload: {
    payment: {
      entity: { id: "pay_test_002", amount: 49900, currency: "INR", status: "captured", method: "card", notes: { packId: "1" } },
    },
  },
});

const REFUND_EVENT_BODY = JSON.stringify({
  event: "payment.refunded",
  payload: {
    payment: {
      entity: { id: "pay_test_003", amount: 49900, currency: "INR", status: "refunded", method: "card", notes: {} },
    },
  },
});

interface StoredProviderEvent {
  processedAt: Date | null;
  // RLS hides another tenant's row while the unique index still conflicts.
  visible: boolean;
}

// Holds real state: the defect pinned here is a decision made from whether the row was finished.
function makeWebhookDb(seed: { providerEvent?: StoredProviderEvent } = {}) {
  const store = {
    providerEvent: seed.providerEvent ?? null as StoredProviderEvent | null,
    recordedEvents: [] as Array<Record<string, unknown>>,
    payments: [] as Array<Record<string, unknown>>,
    paymentConflicts: [] as Array<Record<string, unknown>>,
    outbox: [] as Array<Record<string, unknown>>,
    unprocessed: [] as Array<Record<string, unknown>>,
    order: [] as string[],
  };

  const surface = {
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          if (table === outboxEvents) {
            store.order.push("outbox");
            store.outbox.push(values);
            return Promise.resolve([]);
          }
          return {
            onConflictDoNothing: () => ({
              returning: () => {
                if (table !== providerWebhookEvents) return Promise.resolve([{ id: 1 }]);
                store.order.push("record-event");
                if (store.providerEvent) return Promise.resolve([]);
                store.providerEvent = { processedAt: null, visible: true };
                store.recordedEvents.push(values);
                return Promise.resolve([{ id: 1 }]);
              },
            }),
            onConflictDoUpdate: (config: Record<string, unknown>) => {
              store.order.push("persist-payment");
              store.payments.push(values);
              store.paymentConflicts.push(config);
              return Promise.resolve([]);
            },
          };
        },
      };
    },
    select() {
      const rows = (table: unknown) => {
        if (table !== providerWebhookEvents) return [];
        const row = store.providerEvent;
        return row && row.visible ? [{ processedAt: row.processedAt }] : [];
      };
      return {
        from: (table: unknown) => {
          const limit = () => Promise.resolve(rows(table));
          const where = () => ({ limit, orderBy: () => ({ limit: () => Promise.resolve(store.unprocessed) }) });
          return { where, limit };
        },
      };
    },
    update(table: unknown) {
      return {
        set: (values: Record<string, unknown>) => ({
          where: () => {
            if (table === providerWebhookEvents && store.providerEvent) {
              store.order.push("acknowledge");
              store.providerEvent.processedAt = (values.processedAt as Date | undefined) ?? new Date();
            }
            return Promise.resolve([]);
          },
        }),
      };
    },
    execute: jest.fn().mockResolvedValue([]),
    transaction: jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(surface)),
    query: {
      organizations: { findFirst: jest.fn().mockResolvedValue(null) },
      coupons: { findFirst: jest.fn().mockResolvedValue(null) },
      couponRedemptions: { findFirst: jest.fn().mockResolvedValue(null) },
    },
  };

  return Object.assign(surface, { _store: store });
}

type WebhookDb = ReturnType<typeof makeWebhookDb>;

function makeAiCredits() {
  return {
    grantPlanCredits: jest.fn().mockResolvedValue(undefined),
    grantAiPackCreditsFromWebhook: jest.fn().mockResolvedValue(undefined),
  };
}

function makeEffectLedger() {
  return {
    execute: jest.fn().mockImplementation(async (_effect: unknown, send: () => Promise<void>) => {
      await send();
      return "EXECUTED";
    }),
  };
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

interface Harness {
  service: BillingService;
  db: WebhookDb;
  aiCredits: ReturnType<typeof makeAiCredits>;
  ledger: { execute: jest.Mock };
  webhookHealth: { recordSignatureFailure: jest.Mock };
  notices: { notifyOwner: jest.Mock; track: jest.Mock };
}

async function buildHarness(options: {
  db?: WebhookDb;
  providers?: PaymentProviderResolver;
  aiCredits?: ReturnType<typeof makeAiCredits>;
  ledger?: { execute: jest.Mock };
} = {}): Promise<Harness> {
  const db = options.db ?? makeWebhookDb();
  const aiCredits = options.aiCredits ?? makeAiCredits();
  const ledger = options.ledger ?? makeEffectLedger();
  const webhookHealth = { recordSignatureFailure: jest.fn().mockResolvedValue(undefined) };
  const notices = { notifyOwner: jest.fn().mockResolvedValue(undefined), track: jest.fn() };

  const module = await Test.createTestingModule({
    providers: [
      BillingService,
      RevenueAnalyticsService,
      { provide: DRIZZLE, useValue: db },
      { provide: OutboxConsumerRegistry, useValue: { register: jest.fn(), get: jest.fn() } },
      { provide: AiCreditsService, useValue: aiCredits },
      { provide: AuditService, useValue: { log: jest.fn(), logCritical: jest.fn() } },
      { provide: PlanLimitsService, useValue: { bust: jest.fn(), resolveTier: jest.fn().mockResolvedValue({ plan: "STARTER" }) } },

      { provide: ProrationLedgerService, useValue: { recordPlanChange: jest.fn().mockResolvedValue(undefined) } },

      { provide: VersionedCatalogService, useValue: { getActivePriceForPlanTier: jest.fn().mockResolvedValue(null) } },
      { provide: PaymentProviderResolver, useValue: options.providers ?? makeResolver(new FakeProviderAdapter()) },
      { provide: ExternalEffectLedger, useValue: ledger },
      { provide: PaymentWebhookReceiverService, useValue: webhookHealth },
      { provide: PaymentAnalyticsService, useValue: notices },
      { provide: BillingProfileService, useValue: { get: jest.fn(), update: jest.fn() } },
    ],
  }).compile();

  return { service: module.get(BillingService), db, aiCredits, ledger, webhookHealth, notices };
}

describe("c17-01 — a provider event is recorded before it is acted on", () => {
  describe("the signature is verified before any side effect, including before the ledger write", () => {
    it("records nothing at all when the signature does not match", async () => {
      const { service, db, ledger } = await buildHarness();

      const result = await service.handleRazorpayWebhook("org1", VALID_PAYMENT_BODY, "forged-signature");

      expect(result.status).toBe(401);
      expect(db._store.recordedEvents).toHaveLength(0);
      expect(db._store.payments).toHaveLength(0);
      expect(db._store.outbox).toHaveLength(0);
      expect(ledger.execute).not.toHaveBeenCalled();
      expect(db.query.organizations.findFirst).not.toHaveBeenCalled();
    });

    it("records nothing when the secret itself is wrong", async () => {
      const { service, db } = await buildHarness({
        providers: makeResolver(new FakeProviderAdapter(), "wrong-secret"),
      });

      const result = await service.handleRazorpayWebhook("org1", VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(401);
      expect(db._store.recordedEvents).toHaveLength(0);
    });

    it("records the event before it persists the payment", async () => {
      const { service, db } = await buildHarness();

      await service.handleRazorpayWebhook("org1", VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(db._store.order.indexOf("record-event")).toBeLessThan(db._store.order.indexOf("persist-payment"));
    });
  });

  describe("every provider event is stored with the provider's event id, unique", () => {
    it("stores the provider, its event id, the event type and the raw payload", async () => {
      const { service, db } = await buildHarness();

      await service.handleRazorpayWebhook("org1", VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(db._store.recordedEvents[0]).toMatchObject({
        orgId: "org1",
        provider: "razorpay",
        providerEventId: "pay_test_001",
        eventType: "payment.authorized",
      });
      expect(db._store.recordedEvents[0]?.rawPayload).toEqual(JSON.parse(VALID_PAYMENT_BODY));
    });

    it("keys the ledger on the provider's own id, not one this service invents", async () => {
      const { service, db } = await buildHarness();

      await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(db._store.recordedEvents[0]?.providerEventId).toBe("pay_test_002");
    });
  });

  describe("a duplicate event short-circuits and changes nothing", () => {
    it("answers duplicate and touches nothing when the event already finished", async () => {
      const db = makeWebhookDb({ providerEvent: { processedAt: new Date(), visible: true } });
      const { service, ledger } = await buildHarness({ db });

      const result = await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result).toEqual({ status: 200, body: { ok: true, duplicate: true } });
      expect(db._store.payments).toHaveLength(0);
      expect(db._store.outbox).toHaveLength(0);
      expect(ledger.execute).not.toHaveBeenCalled();
    });

    it("grants once across a replay of the same completed event", async () => {
      const db = makeWebhookDb();
      const { service, aiCredits } = await buildHarness({ db });

      const first = await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);
      const second = await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(first.status).toBe(200);
      expect(second.body).toMatchObject({ duplicate: true });
      expect(aiCredits.grantAiPackCreditsFromWebhook).toHaveBeenCalledTimes(1);
    });

    it("refuses an event id already held by another tenant instead of reporting success", async () => {
      const db = makeWebhookDb({ providerEvent: { processedAt: null, visible: false } });
      const { service, ledger } = await buildHarness({ db });

      const result = await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({ ok: false });
      expect(ledger.execute).not.toHaveBeenCalled();
    });
  });

  describe("a forged event changes nothing and is reported", () => {
    it("reports the rejected signature through the provider's endpoint health", async () => {
      const { service, webhookHealth } = await buildHarness();

      await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, "forged-sig");

      expect(webhookHealth.recordSignatureFailure).toHaveBeenCalledWith("org1", "razorpay");
    });

    it("does not report a rejected signature when the signature was in fact valid", async () => {
      const { service, webhookHealth } = await buildHarness();

      await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(webhookHealth.recordSignatureFailure).not.toHaveBeenCalled();
    });

    it("leaks neither key nor secret in the rejection body", async () => {
      const { service } = await buildHarness({ providers: makeResolver() });

      const result = await service.handleRazorpayWebhook("org1", VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(503);
      const body = JSON.stringify(result.body);
      expect(body).not.toContain("secret");
      expect(body).not.toContain("key");
    });
  });

  describe("out-of-order arrival does not corrupt state", () => {
    it("guards the payment upsert so a stale status cannot overwrite a later one", async () => {
      const { service, db } = await buildHarness();

      await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      const conflict = db._store.paymentConflicts[0];
      expect(conflict?.setWhere).toBeDefined();
      const guard = dialect.sqlToQuery(conflict?.setWhere as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
      expect(guard).toContain('"platform_payments"."status"');
      expect(guard.trimEnd().endsWith("<= 3")).toBe(true);
    });

    it("carries the stored capture time forward rather than nulling it on a later event", async () => {
      const { service, db } = await buildHarness();

      await service.handleRazorpayWebhook("org1", REFUND_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      const conflict = db._store.paymentConflicts[0];
      const set = conflict?.set as Record<string, unknown>;
      expect(set.capturedAt).not.toBeNull();
      expect(set.refundedAt).toBeInstanceOf(Date);
    });
  });
});

describe("c17-02 — a webhook acknowledges only durable work", () => {
  describe("success is returned only after the work has committed", () => {
    it("acknowledges the event after the grant, never before", async () => {
      const { service, db } = await buildHarness();

      const result = await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(200);
      expect(db._store.order.indexOf("acknowledge")).toBe(db._store.order.length - 1);
      expect(db._store.providerEvent?.processedAt).toBeInstanceOf(Date);
    });

    it("returns a failure when acknowledging the event does not commit", async () => {
      const db = makeWebhookDb();
      db.update = jest.fn().mockReturnValue({
        set: () => ({ where: () => Promise.reject(new Error("connection reset")) }),
      }) as unknown as WebhookDb["update"];
      const { service } = await buildHarness({ db });

      const result = await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(500);
    });
  });

  describe("forcing the credit grant to fail makes the endpoint return a failure", () => {
    it("returns 500 so the provider retries", async () => {
      const aiCredits = makeAiCredits();
      aiCredits.grantAiPackCreditsFromWebhook.mockRejectedValue(new Error("db unavailable"));
      const { service } = await buildHarness({ aiCredits });

      const result = await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result).toEqual({ status: 500, body: { ok: false } });
    });

    it("returns 503 while a concurrent attempt holds the grant lease", async () => {
      const ledger = { execute: jest.fn().mockRejectedValue(new ExternalEffectLeaseBusyError("pay_test_002:pack-credit-grant")) };
      const { service } = await buildHarness({ ledger });

      const result = await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(503);
    });
  });

  describe("no partial state persists after a failed attempt", () => {
    it("leaves the event unacknowledged when the grant fails", async () => {
      const aiCredits = makeAiCredits();
      aiCredits.grantAiPackCreditsFromWebhook.mockRejectedValue(new Error("db unavailable"));
      const { service, db } = await buildHarness({ aiCredits });

      await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(db._store.providerEvent?.processedAt).toBeNull();
      expect(db._store.order).not.toContain("acknowledge");
    });

    it("enqueues no revenue event when the grant fails", async () => {
      const aiCredits = makeAiCredits();
      aiCredits.grantAiPackCreditsFromWebhook.mockRejectedValue(new Error("db unavailable"));
      const { service, db } = await buildHarness({ aiCredits });

      await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(db._store.outbox).toHaveLength(0);
    });
  });

  describe("a retry after failure re-drives the work rather than being waved through", () => {
    it("re-runs the grant when the recorded event was never acknowledged", async () => {
      const db = makeWebhookDb({ providerEvent: { processedAt: null, visible: true } });
      const { service, aiCredits } = await buildHarness({ db });

      const result = await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.body).not.toMatchObject({ duplicate: true });
      expect(aiCredits.grantAiPackCreditsFromWebhook).toHaveBeenCalledTimes(1);
      expect(db._store.providerEvent?.processedAt).toBeInstanceOf(Date);
    });

    it("a failed attempt followed by a retry ends with the credits granted", async () => {
      const aiCredits = makeAiCredits();
      aiCredits.grantAiPackCreditsFromWebhook.mockRejectedValueOnce(new Error("db unavailable"));
      const db = makeWebhookDb();
      const { service } = await buildHarness({ db, aiCredits });

      const first = await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);
      const second = await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(first.status).toBe(500);
      expect(second.status).toBe(200);
      expect(aiCredits.grantAiPackCreditsFromWebhook).toHaveBeenCalledTimes(2);
      expect(db._store.providerEvent?.processedAt).toBeInstanceOf(Date);
    });

    it("a retry does not double-credit once the effect has already succeeded", async () => {
      const db = makeWebhookDb({ providerEvent: { processedAt: null, visible: true } });
      const aiCredits = makeAiCredits();
      const ledger = { execute: jest.fn().mockResolvedValue("ALREADY_SUCCEEDED") };
      const { service } = await buildHarness({ db, aiCredits, ledger });

      const result = await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(200);
      expect(aiCredits.grantAiPackCreditsFromWebhook).not.toHaveBeenCalled();
      expect(db._store.providerEvent?.processedAt).toBeInstanceOf(Date);
    });
  });

  describe("failed provisioning is visible in a queue rather than lost", () => {
    it("lists the events whose effects never completed, without their raw payload", async () => {
      const db = makeWebhookDb();
      db._store.unprocessed = [
        { id: 7, provider: "razorpay", providerEventId: "pay_stuck", eventType: "payment.captured", receivedAt: new Date() },
      ];
      const { service } = await buildHarness({ db });

      const result = await service.listProvisioningFailures("org1");

      expect(result.total).toBe(1);
      expect(result.events[0]).toMatchObject({ providerEventId: "pay_stuck" });
      expect(JSON.stringify(result.events)).not.toContain("rawPayload");
    });

    it("reports an empty queue when nothing is stuck", async () => {
      const { service } = await buildHarness();
      await expect(service.listProvisioningFailures("org1")).resolves.toEqual({ events: [], total: 0 });
    });
  });

  describe("a customer whose payment succeeded but provisioning did not is informed", () => {
    it("tells the organisation when the credit grant fails", async () => {
      const aiCredits = makeAiCredits();
      aiCredits.grantAiPackCreditsFromWebhook.mockRejectedValue(new Error("db unavailable"));
      const { service, notices } = await buildHarness({ aiCredits });

      await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(notices.notifyOwner).toHaveBeenCalledTimes(1);
      const [orgId, notice] = notices.notifyOwner.mock.calls[0] as [string, { message: string; priority: string }];
      expect(orgId).toBe("org1");
      expect(notice.priority).toBe("HIGH");
      expect(notice.message).toContain("retrying");
    });

    it("says nothing when provisioning succeeded", async () => {
      const { service, notices } = await buildHarness();

      await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(notices.notifyOwner).not.toHaveBeenCalled();
    });

    it("does not let a failed notification mask the failure that caused it", async () => {
      const aiCredits = makeAiCredits();
      aiCredits.grantAiPackCreditsFromWebhook.mockRejectedValue(new Error("db unavailable"));
      const ledger = {
        execute: jest.fn().mockImplementation(async (effect: { effectType: string }, send: () => Promise<void>) => {
          if (effect.effectType === "billing.provisioning-failure-notice") throw new Error("notifications down");
          await send();
          return "EXECUTED";
        }),
      };
      const { service } = await buildHarness({ aiCredits, ledger });

      const result = await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

      expect(result).toEqual({ status: 500, body: { ok: false } });
    });
  });
});

describe("c17-05 — the webhook's billing state changes enqueue their revenue events", () => {
  it("enqueues an addon purchase for a completed AI pack payment", async () => {
    const { service, db } = await buildHarness();

    await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

    expect(db._store.outbox).toHaveLength(1);
    const payload = db._store.outbox[0]?.payload as { type: string; amount: number; mrr: number };
    expect(db._store.outbox[0]).toMatchObject({ eventType: "billing.revenue-event", organizationId: "org1" });
    expect(payload).toMatchObject({ type: "addon_purchase", mrr: 0, amount: 49900 });
  });

  it("enqueues a refund when the provider reports the payment refunded", async () => {
    const { service, db } = await buildHarness();

    await service.handleRazorpayWebhook("org1", REFUND_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

    const payload = db._store.outbox[0]?.payload as { type: string; amount: number };
    expect(payload).toMatchObject({ type: "refund", amount: 49900 });
  });

  it("enqueues nothing for an event that moves no money", async () => {
    const { service, db } = await buildHarness();

    await service.handleRazorpayWebhook("org1", VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

    expect(db._store.outbox).toHaveLength(0);
  });

  it("enqueues the revenue event in the same commit that acknowledges the webhook", async () => {
    const { service, db } = await buildHarness();

    await service.handleRazorpayWebhook("org1", CAPTURE_EVENT_BODY, FAKE_VALID_WEBHOOK_SIG);

    expect(db._store.order.indexOf("outbox")).toBe(db._store.order.indexOf("acknowledge") - 1);
  });
});

describe("provider substitution — same billing flow, different adapter", () => {
  it("resolves the provider named by the route and produces the same domain outcome", async () => {
    const providers1 = makeResolver(new FakeProviderAdapter("razorpay"));
    const providers2 = makeResolver(new FakeProviderAdapter("stripe"));
    const one = await buildHarness({ providers: providers1 });
    const two = await buildHarness({ providers: providers2 });

    const result1 = await one.service.handlePaymentProviderWebhook("org1", "razorpay", VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);
    const result2 = await two.service.handlePaymentProviderWebhook("org1", "stripe", VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);

    expect(result1).toEqual(result2);
    expect(providers1.resolve).toHaveBeenCalledWith("org1", "razorpay");
    expect(providers2.resolve).toHaveBeenCalledWith("org1", "stripe");
  });
});

describe("legacy Razorpay webhook compatibility route", () => {
  it("preserves the old URL contract while delegating to the provider-neutral handler", async () => {
    const handlePaymentProviderWebhook = jest.fn().mockResolvedValue({ status: 200, body: { ok: true } });
    const controller = new RazorpayWebhookController({ handlePaymentProviderWebhook } as unknown as BillingService);
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });

    await controller.handle(
      "org1",
      { rawBody: Buffer.from(VALID_PAYMENT_BODY) } as never,
      FAKE_VALID_WEBHOOK_SIG,
      { status } as never,
    );

    expect(handlePaymentProviderWebhook).toHaveBeenCalledWith("org1", "razorpay", VALID_PAYMENT_BODY, FAKE_VALID_WEBHOOK_SIG);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ ok: true });
  });
});
