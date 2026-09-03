import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { NotificationDispatchService } from "./notification-dispatch.service";
import { NotificationOutboxRelayService } from "./notification-outbox-relay.service";

const ORG = "org-a";

/**
 * The relay is the safety net behind `emit`: when the immediate drain never runs — the
 * process died between commit and drain — this is what recovers the notification. It is
 * also the only place a replay can double-deliver, so both halves are pinned here.
 */
describe("NotificationOutboxRelayService", () => {
  const emitNow = jest.fn();
  const claimed: Array<Record<string, unknown>> = [];
  const marked: Array<Record<string, unknown>> = [];

  function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 1,
      orgId: ORG,
      eventKey: "chat.message.direct",
      dedupeKey: "chat.message.direct:::user-2:intent-abc",
      actorUserId: "user-1",
      notifySelf: false,
      targetUserIds: ["user-2"],
      entityType: null,
      entityId: null,
      title: null,
      message: null,
      link: null,
      variables: {},
      metadata: null,
      attemptCount: 0,
      ...overrides,
    };
  }

  interface MockDb {
    select: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
    update: jest.Mock;
  }

  const db: MockDb = {
    // forEachOrg lists organisations, then the relay leases rows inside each one's
    // tenant transaction. Stubbing both is enough for the relay's own logic, which is
    // what is under test here.
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockResolvedValue([{ id: ORG }]),
        }),
      }),
    }),
    execute: jest.fn().mockResolvedValue([]),
    transaction: jest.fn((fn: (t: MockDb) => Promise<unknown>) => fn(db)),
    update: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockImplementation((patch: Record<string, unknown>) => ({
        where: jest.fn().mockImplementation(() => {
          marked.push(patch);
          return { returning: jest.fn().mockResolvedValue(claimed) };
        }),
        returning: jest.fn().mockResolvedValue(claimed),
      })),
    })),
  };

  let svc: NotificationOutboxRelayService;

  beforeEach(async () => {
    jest.clearAllMocks();
    claimed.length = 0;
    marked.length = 0;
    emitNow.mockResolvedValue({ notified: 1 });

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationOutboxRelayService,
        { provide: DRIZZLE, useValue: db },
        { provide: NotificationDispatchService, useValue: { emitNow } },
      ],
    }).compile();

    svc = moduleRef.get(NotificationOutboxRelayService);
  });

  it("recovers an intent whose immediate drain never ran", async () => {
    claimed.push(row());

    const result = await svc.flush();

    expect(result.processed).toBe(1);
    expect(emitNow).toHaveBeenCalledTimes(1);
    expect(marked).toContainEqual(expect.objectContaining({ state: "PROCESSED" }));
  });

  /**
   * The whole reason the row's key is threaded through. `chat.message.direct` sets
   * `dedupeWindowSeconds: 0`, so without this the delivery idempotency key falls back to
   * a fresh uuid, the unique index never fires, and a replayed row sends a second DM.
   *
   * It travels as `replayKey`, not `dedupeKey`. The row's key is a random UUID for any
   * emission that supplied no key of its own — 84 of 111 emit sites — and passing it as
   * `dedupeKey` made it WIN over the event's declared time bucket in
   * `buildNotifIdempotencyKey`, so `dedupeWindowSeconds` applied to almost nothing.
   */
  it("passes the row's key down as a replay key so a replay cannot double-deliver", async () => {
    claimed.push(row());

    await svc.flush();

    expect(emitNow).toHaveBeenCalledWith(
      expect.objectContaining({ replayKey: "chat.message.direct:::user-2:intent-abc" }),
    );
    // And NOT as a caller dedupe key, which is what overrode the window.
    expect(emitNow.mock.calls[0]?.[0]).not.toHaveProperty("dedupeKey");
  });

  it("keeps a failed intent for another pass instead of dropping it", async () => {
    claimed.push(row());
    emitNow.mockRejectedValue(new Error("42501 no tenant context"));

    const result = await svc.flush();

    expect(result.retried).toBe(1);
    expect(result.processed).toBe(0);
    expect(marked).toContainEqual(
      expect.objectContaining({ state: "PENDING", attemptCount: 1 }),
    );
  });

  it("dead-letters rather than retrying forever", async () => {
    claimed.push(row({ attemptCount: 4 }));
    emitNow.mockRejectedValue(new Error("permanently broken"));

    const result = await svc.flush();

    expect(result.dead).toBe(1);
    expect(marked).toContainEqual(expect.objectContaining({ state: "DEAD" }));
  });
});
