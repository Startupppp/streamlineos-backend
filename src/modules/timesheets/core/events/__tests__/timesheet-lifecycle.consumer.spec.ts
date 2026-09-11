import { TimesheetLifecycleConsumer } from "../timesheet-lifecycle.consumer";
import {
  TIMESHEET_LIFECYCLE_EVENTS,
  TIMESHEET_LIFECYCLE_EVENT_TYPES,
} from "../timesheet-lifecycle.events";
import {
  OutboxConsumerRegistry,
  type OutboxEventRow,
} from "../../../../../common/outbox/outbox-consumer.registry";
import type { WebhooksDispatchService } from "../../../../webhooks/webhooks-dispatch.service";

/**
 * TS-06. The registration, and what happens when the event arrives.
 *
 * The registration test is the one that matters and the one that looks like
 * bookkeeping. `OutboxPublisherService.deliver` **throws** on an event type with
 * no registered consumer, and that throw goes down the retry-then-dead-letter
 * path — so a missing registration does not mean "nothing happens", it means
 * every submit, approval, rejection and lock in the platform dead-letters after
 * eight attempts, in a background sweep, silently. A test that asserts all four
 * names are registered is a test that the emits of TS-05 have somewhere to land.
 *
 * Note what is deliberately not stubbed away: nothing calls `handle` bare here
 * except this file, and it can, because the consumer opens no transaction of
 * its own — the publisher wraps it. A spec that called a consumer which *did*
 * expect an ambient tenant transaction would get an RLS refusal that is a
 * property of the spec, not of the product.
 */

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
    /** Present so a consumer that reached for the fire-and-forget form would be caught. */
    dispatch: () => {
      throw new Error("the consumer must await deliverNow, not fire-and-forget dispatch");
    },
  } as unknown as WebhooksDispatchService;
  return { service, calls, failWith: (e: Error) => (fail = e) };
}

describe("TimesheetLifecycleConsumer", () => {
  it("registers a consumer for every lifecycle event type", () => {
    const registry = new OutboxConsumerRegistry();
    new TimesheetLifecycleConsumer(stubWebhooks().service, registry).onModuleInit();

    for (const eventType of TIMESHEET_LIFECYCLE_EVENT_TYPES) {
      expect(registry.get(eventType)?.eventType).toBe(eventType);
    }
    expect(TIMESHEET_LIFECYCLE_EVENT_TYPES).toHaveLength(4);
  });

  it("fans the event out to the organisation's subscribed endpoints", async () => {
    const webhooks = stubWebhooks();
    const consumer = new TimesheetLifecycleConsumer(webhooks.service, new OutboxConsumerRegistry());

    await consumer.handle(eventRow());

    expect(webhooks.calls).toHaveLength(1);
    expect(webhooks.calls[0]).toMatchObject({
      orgId: "org-1",
      eventName: "timesheets.period.locked",
    });
    expect(webhooks.calls[0]!.payload).toMatchObject({ period_id: 42, status: "APPROVED" });
  });

  /**
   * The registered handler and the method are the same code path — a
   * registration that pointed somewhere else would pass the test above and fail
   * in production.
   */
  it("routes through the registered adapter, not just the method", async () => {
    const webhooks = stubWebhooks();
    const registry = new OutboxConsumerRegistry();
    new TimesheetLifecycleConsumer(webhooks.service, registry).onModuleInit();

    const submitted = TIMESHEET_LIFECYCLE_EVENTS.submitted;
    await registry.get(submitted)!.handle(eventRow({ eventType: submitted, payload: { ...PAYLOAD, status: "SUBMITTED" } } as Partial<OutboxEventRow>));

    expect(webhooks.calls[0]!.eventName).toBe(submitted);
  });

  it("throws on a payload that does not match the published schema", async () => {
    const webhooks = stubWebhooks();
    const consumer = new TimesheetLifecycleConsumer(webhooks.service, new OutboxConsumerRegistry());

    await expect(
      consumer.handle(eventRow({ payload: { ...PAYLOAD, period_id: "forty-two" } } as Partial<OutboxEventRow>)),
    ).rejects.toThrow(/does not match its schema/);
    expect(webhooks.calls).toHaveLength(0);
  });

  /**
   * The payload names its own organisation and so does the outbox row. If they
   * ever disagree, the row is authoritative and the payload is evidence of a
   * producer bug — delivering it would send one tenant's timesheet to another
   * tenant's endpoints.
   */
  it("refuses an event whose payload names a different organisation", async () => {
    const webhooks = stubWebhooks();
    const consumer = new TimesheetLifecycleConsumer(webhooks.service, new OutboxConsumerRegistry());

    await expect(
      consumer.handle(eventRow({ payload: { ...PAYLOAD, organization_id: "org-2" } } as Partial<OutboxEventRow>)),
    ).rejects.toThrow(/but the outbox row is org org-1/);
    expect(webhooks.calls).toHaveLength(0);
  });

  /**
   * A delivery failure has to reach the publisher, which is the thing that
   * retries. Swallowing it here would mark the outbox row DELIVERED for an
   * event that reached nobody — the precise failure the outbox exists to
   * prevent.
   */
  it("propagates a delivery failure so the publisher can retry", async () => {
    const webhooks = stubWebhooks();
    webhooks.failWith(new Error("endpoint timed out"));
    const consumer = new TimesheetLifecycleConsumer(webhooks.service, new OutboxConsumerRegistry());

    await expect(consumer.handle(eventRow())).rejects.toThrow("endpoint timed out");
  });
});
