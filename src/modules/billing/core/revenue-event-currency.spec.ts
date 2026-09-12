/**
 * PRD-C125, tax/currency: money in `revenue_events` must name its own denomination.
 *
 * `mrr` and `amount` are integer MINOR UNITS, and two different denominations already reach them.
 * Plan movements come from `PLAN_PRICES_PAISE`, which is paise of `PLATFORM_PRICE_CURRENCY`; a
 * provider webhook pushes `payment.amount`, which is minor units of that payment's own currency —
 * cents for USD, whole yen for JPY, thousandths for KWD. Stored side by side with no label, the
 * integer 100000 is either 1,000.00 INR or 100,000 JPY and nothing in the row decides which.
 *
 * These tests pin the label end to end: the producer puts it on the outbox payload, the consumer
 * writes it onto the row, and the webhook producer reads the payment's currency rather than
 * assuming the platform's.
 */
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { revenueEvents } from "../../../db/schema";
import { outboxEvents } from "../../../db/schema/common/outbox";
import {
  OutboxConsumerRegistry,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { type DbOrTx } from "../../../common/rbac/access-invalidate";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import type { BillingPaymentActivation } from "./billing-payment-activation";
import { BillingWebhookEffects } from "./billing-webhook-effects";
import { BillingPaymentState } from "./billing-payment-state";
import { AiCreditsService } from "./ai-credits.service";
import { ExternalEffectLedger } from "../../../common/outbox/external-effect-ledger";
import { PaymentAnalyticsService } from "../payments/payment-analytics.service";
import { revenueEventPayloadSchema } from "./revenue-events";
import { PLATFORM_PRICE_CURRENCY } from "./plan-entitlements.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  type NormalizedPaymentWebhookEvent,
  type PaymentWebhookPayment,
} from "../payments/dto/webhook.schemas";

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

function makeDb() {
  const store = {
    outbox: [] as Array<Record<string, unknown>>,
    revenue: [] as Array<Record<string, unknown>>,
  };

  const insert = (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      if (table === outboxEvents) store.outbox.push(values);
      if (table === revenueEvents) store.revenue.push(values);
      const rows = [{ id: 1 }];
      return {
        onConflictDoNothing: () => ({ returning: () => Promise.resolve(rows) }),
        returning: () => Promise.resolve(rows),
        then: (resolve: (value: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
      };
    },
  });

  const update = (table: unknown) => ({
    set: () => ({
      where: () => {
        void table;
        return Promise.resolve([]);
      },
    }),
  });

  const select = () => ({
    from: () => {
      const resolved = Promise.resolve([] as Array<Record<string, unknown>>);
      const query = {
        groupBy: () => resolved,
        where: () => query,
        orderBy: () => resolved,
        then: (resolve: (value: Array<Record<string, unknown>>) => unknown) =>
          resolved.then(resolve),
      };
      return query;
    },
  });

  const tx = { insert, update, select, execute: jest.fn().mockResolvedValue([]) };

  return {
    insert,
    update,
    select,
    execute: jest.fn().mockResolvedValue([]),
    transaction: jest.fn().mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    _store: store,
  };
}

async function build(db: ReturnType<typeof makeDb>) {
  const module = await Test.createTestingModule({
    providers: [
      RevenueAnalyticsService,
      { provide: DRIZZLE, useValue: db },
      { provide: OutboxConsumerRegistry, useValue: { register: jest.fn(), get: jest.fn() } },
    ],
  }).compile();
  return { service: module.get(RevenueAnalyticsService), tx: module.get<DbOrTx>(DRIZZLE) };
}

function makeEvent(payload: Record<string, unknown>): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: EVENT_ID,
    organizationId: "org1",
    aggregateType: "revenue_event",
    aggregateId: EVENT_ID,
    aggregateVersion: 1,
    schemaVersion: 1,
    causationId: null,
    correlationId: null,
    actorMembershipId: null,
    audience: "INTERNAL",
    lifecycleState: "ACTIVE",
    deliveryState: "IN_FLIGHT",
    eventType: "billing.revenue-event",
    payload,
    occurredAt: new Date("2026-09-04T00:00:00.000Z"),
    publishedAt: null,
    leaseExpiresAt: null,
    retryCount: 0,
    lastError: null,
    deadLetteredAt: null,
    createdAt: new Date("2026-09-04T00:00:00.000Z"),
  };
}

const JPY_REFUND: PaymentWebhookPayment = {
  id: "pay_jpy_001",
  amount: 100_000,
  currency: "JPY",
  status: "refunded",
  method: "card",
};

const JPY_REFUND_EVENT: NormalizedPaymentWebhookEvent = {
  event: "payment.refunded",
  payload: { payment: { entity: JPY_REFUND } },
};

const JPY_PACK_CAPTURE: PaymentWebhookPayment = {
  id: "pay_jpy_002",
  amount: 100_000,
  currency: "JPY",
  status: "captured",
  method: "card",
  notes: { packId: "1" },
};

const JPY_PACK_EVENT: NormalizedPaymentWebhookEvent = {
  event: "payment.captured",
  payload: { payment: { entity: JPY_PACK_CAPTURE } },
};

function makeEffects(): BillingWebhookEffects {
  const ledger = {
    execute: jest.fn().mockImplementation(async (_effect: unknown, send: () => Promise<void>) => {
      await send();
      return "EXECUTED";
    }),
  } as unknown as ExternalEffectLedger;
  return new BillingWebhookEffects(
    {
      db: {} as Db,
      aiCredits: {
        grantAiPackCreditsFromWebhook: jest.fn().mockResolvedValue(undefined),
      } as unknown as AiCreditsService,
      externalEffectLedger: ledger,
      paymentNotices: { notifyOwner: jest.fn() } as unknown as PaymentAnalyticsService,
      activation: {
        performActivationFromWebhook: jest.fn().mockResolvedValue(undefined),
      } as unknown as BillingPaymentActivation,
    },
    {} as BillingPaymentState,
  );
}

describe("revenue events name the denomination of their own money", () => {
  it("puts the currency on the outbox payload, beside the integer it denominates", async () => {
    const db = makeDb();
    const { service, tx } = await build(db);

    await service.emit(tx, {
      type: "addon_purchase",
      orgId: "org1",
      mrr: 0,
      amount: 100_000,
      currency: "JPY",
    });

    const payload = db._store.outbox[0].payload as Record<string, unknown>;
    expect(payload.amount).toBe(100_000);
    expect(payload.currency).toBe("JPY");
  });

  it("writes the currency onto the revenue_events row the consumer inserts", async () => {
    const db = makeDb();
    const { service } = await build(db);

    await service.handle(
      makeEvent({
        type: "addon_purchase",
        orgId: "org1",
        mrr: 0,
        amount: 100_000,
        currency: "JPY",
      }),
    );

    expect(db._store.revenue).toHaveLength(1);
    expect(db._store.revenue[0].currency).toBe("JPY");
    expect(db._store.revenue[0].amount).toBe(100_000);
  });

  it("declares the column, so the write is not silently dropped by Drizzle", () => {
    expect(Object.keys(revenueEvents)).toContain("currency");
    expect(revenueEvents.currency.name).toBe("currency");
  });

  it("still accepts an event emitted before the column existed, instead of failing it", () => {
    const parsed = revenueEventPayloadSchema.safeParse({
      type: "churn",
      orgId: "org1",
      mrr: 49900,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.currency).toBeNull();
  });

  it("does not write an unparsed legacy event as though it were INR", async () => {
    const db = makeDb();
    const { service } = await build(db);

    await service.handle(makeEvent({ type: "churn", orgId: "org1", mrr: 49900 }));

    expect(db._store.revenue).toHaveLength(1);
    expect(db._store.revenue[0].currency).toBeUndefined();
  });
});

describe("a provider webhook labels its money with the payment's currency, not the platform's", () => {
  it("labels a refund JPY when the payment was in JPY", async () => {
    const applied = await makeEffects().apply(JPY_REFUND_EVENT, JPY_REFUND, "org1", "razorpay", null);

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.revenue).toHaveLength(1);
    expect(applied.revenue[0].currency).toBe("JPY");
    expect(applied.revenue[0].currency).not.toBe(PLATFORM_PRICE_CURRENCY);
    expect(applied.revenue[0].amount).toBe(100_000);
  });

  it("labels an AI pack purchase with the same currency the payment carried", async () => {
    const applied = await makeEffects().apply(
      JPY_PACK_EVENT,
      JPY_PACK_CAPTURE,
      "org1",
      "razorpay",
      null,
    );

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.revenue).toHaveLength(1);
    expect(applied.revenue[0].type).toBe("addon_purchase");
    expect(applied.revenue[0].currency).toBe("JPY");
  });
});

describe("platform plan movements are labelled as platform paise", () => {
  it("keeps PLATFORM_PRICE_CURRENCY a three-letter ISO-4217 code the column can hold", () => {
    expect(PLATFORM_PRICE_CURRENCY).toMatch(/^[A-Z]{3}$/);
  });

  it("round-trips a plan movement through the outbox with the platform currency intact", async () => {
    const db = makeDb();
    const { service, tx } = await build(db);

    await service.emit(tx, {
      type: "churn",
      orgId: "org1",
      plan: "PAID",
      mrr: 49900,
      currency: PLATFORM_PRICE_CURRENCY,
      dedupeKey: "dunning-suspension:7",
    });

    const payload = db._store.outbox[0].payload as Record<string, unknown>;
    await service.handle(makeEvent(payload));

    expect(db._store.revenue[0].currency).toBe(PLATFORM_PRICE_CURRENCY);
    expect(db._store.revenue[0].mrr).toBe(49900);
  });
});
