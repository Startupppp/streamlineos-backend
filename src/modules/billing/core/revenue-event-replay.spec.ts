import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { outboxEvents } from "../../../db/schema";
import { OutboxConsumerRegistry } from "../../../common/outbox/outbox-consumer.registry";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { BillingWebhookEffects } from "./billing-webhook-effects";
import { BillingPaymentState } from "./billing-payment-state";
import { AiCreditsService } from "./ai-credits.service";
import { ExternalEffectLedger } from "../../../common/outbox/external-effect-ledger";
import { PaymentAnalyticsService } from "../payments/payment-analytics.service";
import { type Db } from "../../../db/drizzle.module";
import {
  type NormalizedPaymentWebhookEvent,
  type PaymentWebhookPayment,
} from "../payments/dto/webhook.schemas";

const ORG = "org-replay";
const PROVIDER = "razorpay";

const REFUNDED: PaymentWebhookPayment = {
  id: "pay_replay_001",
  amount: 49900,
  currency: "INR",
  status: "refunded",
  method: "card",
};

const REFUND_EVENT: NormalizedPaymentWebhookEvent = {
  event: "payment.refunded",
  payload: { payment: { entity: REFUNDED } },
};

const CAPTURED: PaymentWebhookPayment = {
  id: "pay_replay_002",
  amount: 49900,
  currency: "INR",
  status: "captured",
  method: "card",
  notes: { packId: "1" },
};

const CAPTURE_EVENT: NormalizedPaymentWebhookEvent = {
  event: "payment.captured",
  payload: { payment: { entity: CAPTURED } },
};

interface OutboxRow {
  eventId: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

// Captures what the producer actually hands the outbox, which is where the identity lives.
function makeOutboxCapturingDb(): { db: Db; rows: OutboxRow[] } {
  const rows: OutboxRow[] = [];
  const db = {
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          if (table === outboxEvents) rows.push(values as unknown as OutboxRow);
          return Promise.resolve([]);
        },
      };
    },
  } as unknown as Db;
  return { db, rows };
}

async function buildRevenueService(db: Db): Promise<RevenueAnalyticsService> {
  const module = await Test.createTestingModule({
    providers: [
      RevenueAnalyticsService,
      { provide: DRIZZLE, useValue: db },
      { provide: OutboxConsumerRegistry, useValue: { register: jest.fn(), get: jest.fn() } },
    ],
  }).compile();
  return module.get(RevenueAnalyticsService);
}

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
    },
    {} as BillingPaymentState,
  );
}

/**
 * Drives the real producer twice, the way a concurrent redelivery and the redrive sweep both
 * drive it: the ledger row is recorded but not yet acknowledged, so `settle` runs again and the
 * revenue events are re-emitted. `uniq_outbox_events_event_id` can only collapse the second
 * emission if the producer names it identically.
 */
async function emitTwice(
  event: NormalizedPaymentWebhookEvent,
  payment: PaymentWebhookPayment,
): Promise<OutboxRow[]> {
  const effects = makeEffects();
  const { db, rows } = makeOutboxCapturingDb();
  const revenue = await buildRevenueService(db);

  for (let pass = 0; pass < 2; pass += 1) {
    const applied = await effects.apply(event, payment, ORG, PROVIDER);
    if (!applied.ok) throw new Error("effects refused the event");
    for (const entry of applied.revenue) await revenue.emit(db, entry);
  }

  return rows;
}

describe("a re-settled provider event cannot post a second revenue row", () => {
  it("gives both emissions of one refund the same outbox event id", async () => {
    const rows = await emitTwice(REFUND_EVENT, REFUNDED);

    expect(rows).toHaveLength(2);
    expect(rows[0].eventType).toBe("billing.revenue-event");
    expect(rows[0].eventId).toBe(rows[1].eventId);
  });

  it("gives both emissions the same aggregate id, so the per-aggregate fence agrees", async () => {
    const rows = await emitTwice(REFUND_EVENT, REFUNDED);

    expect(rows[0].aggregateId).toBe(rows[1].aggregateId);
    expect(rows[0].aggregateId).toBe(rows[0].eventId);
  });

  it("gives both emissions of one AI pack capture the same outbox event id", async () => {
    const rows = await emitTwice(CAPTURE_EVENT, CAPTURED);

    expect(rows).toHaveLength(2);
    expect((rows[0].payload as { type: string }).type).toBe("addon_purchase");
    expect(rows[0].eventId).toBe(rows[1].eventId);
  });

  it("separates two different payments, so the fence never suppresses a real second movement", async () => {
    const first = await emitTwice(REFUND_EVENT, REFUNDED);
    const second = await emitTwice(REFUND_EVENT, { ...REFUNDED, id: "pay_replay_999" });

    expect(first[0].eventId).not.toBe(second[0].eventId);
  });

  it("is the dedupe key doing the work — an event without one still gets a fresh id each time", async () => {
    const { db, rows } = makeOutboxCapturingDb();
    const revenue = await buildRevenueService(db);

    const entry = { type: "refund" as const, orgId: ORG, mrr: 0, amount: 49900 };
    await revenue.emit(db, entry);
    await revenue.emit(db, entry);

    expect(rows[0].eventId).not.toBe(rows[1].eventId);
  });

  it("keeps the emitted payload identical across the replay, so only the identity is derived", async () => {
    const rows = await emitTwice(REFUND_EVENT, REFUNDED);

    expect(rows[0].payload).toEqual(rows[1].payload);
    expect(rows[0].payload).toMatchObject({ type: "refund", orgId: ORG, mrr: 0, amount: 49900 });
  });

  it("emits an id the outbox envelope accepts as a uuid", async () => {
    const rows = await emitTwice(REFUND_EVENT, REFUNDED);

    expect(rows[0].eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
