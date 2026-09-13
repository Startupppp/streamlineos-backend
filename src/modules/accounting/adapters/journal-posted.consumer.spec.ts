import type { OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";
import { ExternalEffectLeaseBusyError } from "../../../common/outbox/external-effect-ledger";
import { JOURNAL_POSTED_EVENT, JournalPostedConsumer } from "./journal-posted.consumer";

/**
 * Without a registered consumer the publisher dead-letters every posted
 * journal. These pin that the consumer registers itself, forwards the kernel's
 * payload to the org's webhooks untouched, and refuses a row whose payload
 * names a different organisation than the row it arrived on.
 */
function event(overrides: Partial<OutboxEventRow> = {}, payload: Record<string, unknown> = {}): OutboxEventRow {
  return {
    eventId: "evt-1",
    organizationId: "org-a",
    aggregateType: "gl_journal",
    aggregateId: "jrn-1",
    aggregateVersion: 1,
    eventType: JOURNAL_POSTED_EVENT,
    payload: {
      organization_id: "org-a",
      book_id: "book-1",
      journal_id: "jrn-1",
      journal_number: "JV-0001",
      journal_date: "2026-09-11",
      source_type: "stock_move",
      source_id: "grn:7",
      actor_user_id: "usr-1",
      ...payload,
    },
    ...overrides,
  } as OutboxEventRow;
}

describe("JournalPostedConsumer", () => {
  function build(effectsOverride?: { execute: jest.Mock }) {
    const registry = { register: jest.fn() };
    const webhooks = { deliverNow: jest.fn().mockResolvedValue(undefined) };
    const effects = effectsOverride ?? {
      execute: jest.fn().mockImplementation(async (_e: unknown, send: () => Promise<void>) => {
        await send();
        return "EXECUTED" as const;
      }),
    };
    const consumer = new JournalPostedConsumer(webhooks as never, registry as never, effects as never);
    return { consumer, registry, webhooks, effects };
  }

  it("registers itself for accounting.journal.posted on module init", () => {
    const { consumer, registry } = build();
    consumer.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(consumer);
    expect(consumer.eventType).toBe("accounting.journal.posted");
  });

  it("forwards the kernel's payload to the event organisation's webhooks, awaited", async () => {
    const { consumer, webhooks } = build();
    await consumer.handle(event());
    expect(webhooks.deliverNow).toHaveBeenCalledWith(
      "org-a",
      "accounting.journal.posted",
      expect.objectContaining({ journal_id: "jrn-1", journal_number: "JV-0001", source_id: "grn:7" }),
    );
  });

  it("refuses a payload that names another organisation than its outbox row", async () => {
    const { consumer, webhooks } = build();
    await expect(consumer.handle(event({}, { organization_id: "org-b" }))).rejects.toThrow(/names org org-b/);
    expect(webhooks.deliverNow).not.toHaveBeenCalled();
  });

  it("refuses a payload without a journal id rather than delivering a blank event", async () => {
    const { consumer, webhooks } = build();
    await expect(consumer.handle(event({}, { journal_id: "" }))).rejects.toThrow(/does not match its schema/);
    expect(webhooks.deliverNow).not.toHaveBeenCalled();
  });

  it("lets a delivery failure reach the publisher so the row is retried", async () => {
    const { consumer, webhooks } = build();
    webhooks.deliverNow.mockRejectedValueOnce(new Error("endpoint 503"));
    await expect(consumer.handle(event())).rejects.toThrow("endpoint 503");
  });

  describe("ledger fence", () => {
    it("propagates BUSY when an abandoned in-flight send holds the lease — no duplicate delivery", async () => {
      const busyExecute: jest.Mock = jest.fn().mockRejectedValueOnce(
        new ExternalEffectLeaseBusyError("outbox:org-a:accounting:journal-posted:webhook-delivery:evt-1"),
      );
      const { consumer, webhooks } = build({ execute: busyExecute });
      await expect(consumer.handle(event())).rejects.toBeInstanceOf(ExternalEffectLeaseBusyError);
      expect(webhooks.deliverNow).not.toHaveBeenCalled();
    });

    it("suppresses delivery and completes without error when the effect already SUCCEEDED", async () => {
      const succeededExecute: jest.Mock = jest.fn().mockResolvedValueOnce("ALREADY_SUCCEEDED" as const);
      const { consumer, webhooks } = build({ execute: succeededExecute });
      await consumer.handle(event());
      expect(webhooks.deliverNow).not.toHaveBeenCalled();
    });

    it("passes the correct effect descriptor to the ledger for a valid event", async () => {
      const { consumer, effects } = build();
      await consumer.handle(event());
      expect(effects.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org-a",
          producerEventId: "evt-1",
          effectType: "webhook.delivery",
          providerIdempotency: "NONE",
        }),
        expect.any(Function),
      );
    });
  });
});
