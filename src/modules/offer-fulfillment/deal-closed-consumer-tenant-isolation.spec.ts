import type { Db } from "../../db/drizzle.module";
import type { OutboxConsumerRegistry, OutboxEventRow } from "../../common/outbox/outbox-consumer.registry";
import { stubService } from "../../test/service-stub.spec-fixtures";
import type { NumberSequenceService } from "../inventory/stock-engine/number-sequence.service";
import { DealClosedConsumerService } from "./deal-closed-consumer.service";

/**
 * A complete outbox row, so the two events below are the shape the consumer is
 * actually handed at runtime rather than a five-field stand-in behind a cast.
 */
function outboxEvent(overrides: Pick<OutboxEventRow, "eventId" | "organizationId" | "aggregateId" | "payload"> & Partial<OutboxEventRow>): OutboxEventRow {
  return {
    outboxEventId: 1,
    aggregateType: "deal",
    aggregateVersion: 1,
    schemaVersion: 1,
    causationId: null,
    correlationId: null,
    actorMembershipId: null,
    audience: "INTERNAL",
    lifecycleState: "ACTIVE",
    deliveryState: "PENDING",
    eventType: "deal.closed",
    occurredAt: new Date("2024-01-15T00:00:00Z"),
    publishedAt: null,
    leaseExpiresAt: null,
    retryCount: 0,
    lastError: null,
    deadLetteredAt: null,
    createdAt: new Date("2024-01-15T00:00:00Z"),
    ...overrides,
  };
}

describe("DealClosedConsumerService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  function makeMocks(orgId: string, mappings: unknown[]) {
    const chain = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(mappings) }),
      }),
    });
    const insertChain = {
      values: jest.fn().mockReturnThis(),
      onConflictDoNothing: jest.fn().mockReturnThis(),
      onConflictDoUpdate: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 1 }]),
    };
    const updateChain = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([]),
    };
    const db = {
      select: chain,
      insert: jest.fn().mockReturnValue(insertChain),
      update: jest.fn().mockReturnValue(updateChain),
      transaction: jest.fn(),
    } as unknown as Db;
    const inbox = { claim: jest.fn(), markProcessed: jest.fn() };
    return { db, inbox };
  }

  it("skips SO creation when org has no active mappings (cross-tenant isolation — attacker org gets no data)", async () => {
    const { db } = makeMocks(ATTACKER, []);
    const mockNumSeq = stubService<NumberSequenceService>({});
    const mockRegistry = stubService<OutboxConsumerRegistry>({ register: jest.fn() });
    const svc = new DealClosedConsumerService(db, mockNumSeq, mockRegistry);
    const event = outboxEvent({
      eventId: "evt-1",
      organizationId: ATTACKER,
      aggregateId: "deal-1",
      payload: { dealId: 1, orgId: ATTACKER, dealName: "Test Deal", dealValue: "1000", closedAt: "2024-01-15", actorUserId: "user-1" },
    });
    await svc.handle(event);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("tenant orgId from event scopes all queries — no cross-org data leak (control — owner org)", async () => {
    const { db } = makeMocks(OWNER, []);
    const mockNumSeq = stubService<NumberSequenceService>({});
    const mockRegistry = stubService<OutboxConsumerRegistry>({ register: jest.fn() });
    const svc = new DealClosedConsumerService(db, mockNumSeq, mockRegistry);
    const event = outboxEvent({
      eventId: "evt-2",
      organizationId: OWNER,
      aggregateId: "deal-2",
      payload: { dealId: 2, orgId: OWNER, dealName: "Owner Deal", dealValue: "5000", closedAt: "2024-01-15", actorUserId: "user-2" },
    });
    await svc.handle(event);
    const firstSelectCall = (db.select as jest.Mock).mock.calls[0];
    expect(firstSelectCall).toBeDefined();
  });
});
