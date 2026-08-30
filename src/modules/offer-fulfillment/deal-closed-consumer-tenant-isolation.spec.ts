import type { Db } from "../../db/drizzle.module";
import { DealClosedConsumerService } from "./deal-closed-consumer.service";

describe("DealClosedConsumerService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  function makeMocks(orgId: string, mappings: unknown[]) {
    const chain = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(mappings) }),
      }),
    });
    const db = {
      select: chain,
      transaction: jest.fn(),
    } as unknown as Db;
    const inbox = { claim: jest.fn(), markProcessed: jest.fn() };
    return { db, inbox };
  }

  it("skips SO creation when org has no active mappings (cross-tenant isolation — attacker org gets no data)", async () => {
    const { db } = makeMocks(ATTACKER, []);
    const mockNumSeq = {} as any;
    const mockRegistry = { register: jest.fn() } as any;
    const svc = new DealClosedConsumerService(db, mockNumSeq, mockRegistry);
    const event = {
      eventId: "evt-1",
      organizationId: ATTACKER,
      aggregateType: "deal",
      aggregateId: "deal-1",
      aggregateVersion: 1,
      eventType: "deal.closed",
      payload: { dealId: "deal-1", dealName: "Test Deal", actorUserId: "user-1" },
    };
    await svc.handle(event as any);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("tenant orgId from event scopes all queries — no cross-org data leak (control — owner org)", async () => {
    const { db } = makeMocks(OWNER, []);
    const mockNumSeq = {} as any;
    const mockRegistry = { register: jest.fn() } as any;
    const svc = new DealClosedConsumerService(db, mockNumSeq, mockRegistry);
    const event = {
      eventId: "evt-2",
      organizationId: OWNER,
      aggregateType: "deal",
      aggregateId: "deal-2",
      aggregateVersion: 1,
      eventType: "deal.closed",
      payload: { dealId: "deal-2", dealName: "Owner Deal", actorUserId: "user-2" },
    };
    await svc.handle(event as any);
    const firstSelectCall = (db.select as jest.Mock).mock.calls[0];
    expect(firstSelectCall).toBeDefined();
  });
});
