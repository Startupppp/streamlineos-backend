import { ChatChannelMembersService } from "./chat-channel-members.service";
import { RealtimeTokenRevocationConsumer, REALTIME_TOKEN_REVOCATION_EVENT } from "../realtime/realtime-token-revocation";
import { OutboxConsumerRegistry, type OutboxEventRow } from "../../common/outbox/outbox-consumer.registry";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";

jest.mock("../../common/outbox/outbox-writer", () => ({ OutboxWriter: { emit: jest.fn() } }));
jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(_db)),
}));

const emit = OutboxWriter.emit as jest.MockedFunction<typeof OutboxWriter.emit>;
const runTransaction = runInTenantTransaction as jest.MockedFunction<typeof runInTenantTransaction>;

function makeMemberDb() {
  const memberFindFirst = jest
    .fn()
    .mockResolvedValueOnce({ role: "ADMIN" })
    .mockResolvedValue(null);
  const orgMemberFindFirst = jest.fn().mockResolvedValue({ id: 42 });
  const db = {
    query: {
      chatChannels: { findFirst: jest.fn().mockResolvedValue({ id: 1, isPrivate: false }) },
      chatChannelMembers: { findFirst: memberFindFirst, findMany: jest.fn() },
      organizationMembers: { findFirst: orgMemberFindFirst },
    },
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue({ rowCount: 1 }) }),
  };
  return db;
}

describe("chat channel removal realtime durability", () => {
  beforeEach(() => jest.clearAllMocks());

  it("writes token revocation and capability refresh to the same post-commit outbox transaction", async () => {
    const db = makeMemberDb();
    const service = new ChatChannelMembersService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.removeMember(1, "target-user", "admin-user", "org-1");

    expect(runTransaction).toHaveBeenCalledWith(db, expect.any(Function), { orgId: "org-1" });
    expect(emit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        organizationId: "org-1",
        eventType: REALTIME_TOKEN_REVOCATION_EVENT,
        payload: { orgId: "org-1", userId: "target-user", channelId: 1, membershipId: 42 },
      }),
    );
  });
});

function makeEvent(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: "event-1",
    organizationId: "org-1",
    aggregateType: "realtime.token-revocation",
    aggregateId: "1:42:event-1",
    aggregateVersion: 1,
    schemaVersion: 1,
    causationId: null,
    correlationId: null,
    actorMembershipId: null,
    audience: "INTERNAL",
    lifecycleState: "ACTIVE",
    deliveryState: "IN_FLIGHT",
    eventType: REALTIME_TOKEN_REVOCATION_EVENT,
    payload: { orgId: "org-1", userId: "target-user", channelId: 1, membershipId: 42 },
    occurredAt: new Date(),
    publishedAt: null,
    leaseExpiresAt: new Date(Date.now() + 30_000),
    retryCount: 0,
    lastError: null,
    deadLetteredAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeConsumerDb() {
  return {
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 1 }]),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
  };
}

describe("RealtimeTokenRevocationConsumer", () => {
  it("revokes old tokens before refreshing capabilities", async () => {
    const db = makeConsumerDb();
    const calls: string[] = [];
    const ably = {
      revokeUserTokens: jest.fn().mockImplementation(async () => calls.push("revoke")),
      publishToUser: jest.fn().mockImplementation(async () => calls.push("refresh")),
    };
    const consumer = new RealtimeTokenRevocationConsumer(
      db as never,
      ably as never,
      new OutboxConsumerRegistry(),
    );

    await consumer.handle(makeEvent());

    expect(calls).toEqual(["revoke", "refresh"]);
    expect(ably.publishToUser).toHaveBeenCalledWith(
      "org-1",
      "target-user",
      "realtime:capability:refresh",
      {},
      { requireConfigured: true },
    );
  });

  it("propagates provider failure so the outbox publisher retries and can DLQ it", async () => {
    const db = makeConsumerDb();
    const ably = {
      revokeUserTokens: jest.fn().mockRejectedValue(new Error("Ably unavailable")),
      publishToUser: jest.fn(),
    };
    const consumer = new RealtimeTokenRevocationConsumer(
      db as never,
      ably as never,
      new OutboxConsumerRegistry(),
    );

    await expect(consumer.handle(makeEvent())).rejects.toThrow("Ably unavailable");
    expect(ably.publishToUser).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalled();
  });
});
