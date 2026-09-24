import { TimesheetLifecycleConsumer } from "../timesheet-lifecycle.consumer";
import {
  TIMESHEET_LIFECYCLE_EVENTS,
  TIMESHEET_LIFECYCLE_EVENT_TYPES,
} from "../timesheet-lifecycle.events";
import {
  OutboxConsumerRegistry,
  type OutboxEventRow,
} from "../../../../../common/outbox/outbox-consumer.registry";
import { ExternalEffectLeaseBusyError } from "../../../../../common/outbox/external-effect-ledger";
import type { WebhooksDispatchService } from "../../../../webhooks/webhooks-dispatch.service";

const PAYLOAD = {
  organization_id: "org-1",
  period_id: 42,
  user_id: "usr-worker",
  period_start: "2026-09-01",
  period_end: "2026-09-07",
  status: "APPROVED",
  total_hours: "38.50",
  billable_hours: "31.00",
  non_billable_hours: "7.50",
  actor_user_id: "usr-boss",
  reason: null,
  occurred_at: "2026-09-09T11:04:22.883Z",
};

function eventRow(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    eventId: "11111111-1111-4111-8111-111111111111",
    organizationId: "org-1",
    eventType: TIMESHEET_LIFECYCLE_EVENTS.locked,
    payload: PAYLOAD,
    ...overrides,
  } as unknown as OutboxEventRow;
}

function stubWebhooks() {
  const calls: Array<{ orgId: string; eventName: string; payload: Record<string, unknown> }> = [];
  let fail: Error | null = null;
  const service = {
    deliverNow: async (orgId: string, eventName: string, payload: Record<string, unknown>) => {
      if (fail) throw fail;
      calls.push({ orgId, eventName, payload });
    },
    dispatch: () => {
      throw new Error("the consumer must await deliverNow, not fire-and-forget dispatch");
    },
  } as unknown as WebhooksDispatchService;
  return { service, calls, failWith: (e: Error) => (fail = e) };
}

function passThruEffects() {
  return {
    execute: jest.fn().mockImplementation(async (_e: unknown, send: () => Promise<void>) => {
      await send();
      return "EXECUTED" as const;
    }),
  };
}

describe("TimesheetLifecycleConsumer", () => {
  it("registers a consumer for every lifecycle event type", () => {
    const registry = new OutboxConsumerRegistry();
    new TimesheetLifecycleConsumer(stubWebhooks().service, registry, passThruEffects() as never).onModuleInit();

    for (const eventType of TIMESHEET_LIFECYCLE_EVENT_TYPES) {
      expect(registry.get(eventType)?.eventType).toBe(eventType);
    }
    expect(TIMESHEET_LIFECYCLE_EVENT_TYPES).toHaveLength(4);
  });

  it("fans the event out to the organisation's subscribed endpoints", async () => {
    const webhooks = stubWebhooks();
    const consumer = new TimesheetLifecycleConsumer(webhooks.service, new OutboxConsumerRegistry(), passThruEffects() as never);

    await consumer.handle(eventRow());

    expect(webhooks.calls).toHaveLength(1);
    expect(webhooks.calls[0]).toMatchObject({
      orgId: "org-1",
      eventName: "timesheets.period.locked",
    });
    expect(webhooks.calls[0]!.payload).toMatchObject({ period_id: 42, status: "APPROVED" });
  });

  it("routes through the registered adapter, not just the method", async () => {
    const webhooks = stubWebhooks();
    const registry = new OutboxConsumerRegistry();
    new TimesheetLifecycleConsumer(webhooks.service, registry, passThruEffects() as never).onModuleInit();

    const submitted = TIMESHEET_LIFECYCLE_EVENTS.submitted;
    await registry.get(submitted)!.handle(eventRow({ eventType: submitted, payload: { ...PAYLOAD, status: "SUBMITTED" } } as Partial<OutboxEventRow>));

    expect(webhooks.calls[0]!.eventName).toBe(submitted);
  });

  it("throws on a payload that does not match the published schema", async () => {
    const webhooks = stubWebhooks();
    const consumer = new TimesheetLifecycleConsumer(webhooks.service, new OutboxConsumerRegistry(), passThruEffects() as never);

    await expect(
      consumer.handle(eventRow({ payload: { ...PAYLOAD, period_id: "forty-two" } } as Partial<OutboxEventRow>)),
    ).rejects.toThrow(/does not match its schema/);
    expect(webhooks.calls).toHaveLength(0);
  });

  it("refuses an event whose payload names a different organisation", async () => {
    const webhooks = stubWebhooks();
    const consumer = new TimesheetLifecycleConsumer(webhooks.service, new OutboxConsumerRegistry(), passThruEffects() as never);

    await expect(
      consumer.handle(eventRow({ payload: { ...PAYLOAD, organization_id: "org-2" } } as Partial<OutboxEventRow>)),
    ).rejects.toThrow(/but the outbox row is org org-1/);
    expect(webhooks.calls).toHaveLength(0);
  });

  it("propagates a delivery failure so the publisher can retry", async () => {
    const webhooks = stubWebhooks();
    webhooks.failWith(new Error("endpoint timed out"));
    const consumer = new TimesheetLifecycleConsumer(webhooks.service, new OutboxConsumerRegistry(), passThruEffects() as never);

    await expect(consumer.handle(eventRow())).rejects.toThrow("endpoint timed out");
  });

  describe("ledger fence", () => {
    it("propagates BUSY when an abandoned in-flight send holds the lease — no duplicate delivery", async () => {
      const busyEffects = {
        execute: jest.fn().mockRejectedValueOnce(
          new ExternalEffectLeaseBusyError("outbox:org-1:timesheets:lifecycle:webhook-delivery:11111111-1111-4111-8111-111111111111"),
        ),
      };
      const webhooks = stubWebhooks();
      const consumer = new TimesheetLifecycleConsumer(webhooks.service, new OutboxConsumerRegistry(), busyEffects as never);
      await expect(consumer.handle(eventRow())).rejects.toBeInstanceOf(ExternalEffectLeaseBusyError);
      expect(webhooks.calls).toHaveLength(0);
    });

    it("suppresses delivery and completes without error when the effect already SUCCEEDED", async () => {
      const succeededEffects = {
        execute: jest.fn().mockResolvedValueOnce("ALREADY_SUCCEEDED" as const),
      };
      const webhooks = stubWebhooks();
      const consumer = new TimesheetLifecycleConsumer(webhooks.service, new OutboxConsumerRegistry(), succeededEffects as never);
      await consumer.handle(eventRow());
      expect(webhooks.calls).toHaveLength(0);
    });
  });
});
