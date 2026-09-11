import type { OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";
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
  function build() {
    const registry = { register: jest.fn() };
    const webhooks = { deliverNow: jest.fn().mockResolvedValue(undefined) };
    const consumer = new JournalPostedConsumer(webhooks as never, registry as never);
    return { consumer, registry, webhooks };
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
});
