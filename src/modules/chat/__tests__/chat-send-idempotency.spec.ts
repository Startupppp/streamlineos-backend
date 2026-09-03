import { Test, type TestingModule } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CacheService } from "../../../common/cache/cache.service";
import { AblyService } from "../../realtime/ably.service";
import { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import { ChatMessagesService } from "../chat-messages.service";
import { ChatReplyRemindersService } from "../chat-reply-reminders.service";
import { ChatOrgSettingsService } from "../chat-org-settings.service";
import { MESSAGE_FANOUT_PROVIDER } from "../message-fanout.interface";
import { StorageService } from "../../storage/storage.service";
import { chatMessages } from "../../../db/schema";
import { CHAT_MESSAGE_CLIENT_KEY_CONFLICT } from "../chat-message-conflict-target";

/**
 * A send whose response is lost is retried by the client. Without a durable key the
 * retry inserts a second message; the partial unique index on
 * (org_id, channel_id, client_key) makes it collide, and the loser replays the winner.
 *
 * The database here is a fake, so it cannot see whether Postgres can arbitrate that
 * partial index — this suite passed for the whole time every send 500'd on 42P10.
 * `chat-send-conflict-target.db.spec.ts` is the half that executes real SQL; all this
 * one can honestly claim is that the send path hands over the shared conflict spec.
 */
const ORG = "org-a";
const USER = "user-1";
const CHANNEL = 42;
const CLIENT_KEY = "composer-key-1";

const existing = {
  id: 7,
  orgId: ORG,
  channelId: CHANNEL,
  content: "hello",
  clientKey: CLIENT_KEY,
  createdAt: new Date(),
  metadata: null,
};

function makeDb(overrides: { replayed?: unknown; inserted?: unknown[] } = {}) {
  const { replayed = undefined, inserted = [existing] } = overrides;
  const chain: Record<string, unknown> = {};
  for (const m of ["insert", "values", "update", "set", "where", "from", "select", "delete", "onConflictDoNothing", "orderBy"])
    chain[m] = jest.fn(() => chain);
  chain.returning = jest.fn().mockResolvedValue(inserted);
  chain.limit = jest.fn().mockResolvedValue([{ id: CHANNEL, type: "GROUP" }]);
  chain.query = {
    organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 10 }) },
    chatChannelMembers: {
      findFirst: jest.fn().mockResolvedValue({ id: 10 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    chatMessages: { findFirst: jest.fn().mockResolvedValue(replayed) },
    chatChannels: { findFirst: jest.fn().mockResolvedValue({ id: CHANNEL, type: "GROUP" }) },
    users: { findFirst: jest.fn().mockResolvedValue({ name: "A" }) },
  };
  chain.transaction = jest.fn((cb: (tx: unknown) => Promise<unknown>) => cb(chain));
  return chain;
}

async function build(db: Record<string, unknown>): Promise<ChatMessagesService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ChatMessagesService,
      { provide: DRIZZLE, useValue: db },
      { provide: CacheService, useValue: { invalidateNamespace: jest.fn(), cached: jest.fn(), invalidate: jest.fn() } },
      { provide: AblyService, useValue: { configured: false, publishChatEvent: jest.fn() } },
      { provide: ChatReplyRemindersService, useValue: { scheduleForMessage: jest.fn() } },
      { provide: ChatOrgSettingsService, useValue: { getSettings: jest.fn().mockResolvedValue({ maxAttachmentSizeMb: 25 }) } },
      { provide: EntityReferenceService, useValue: { resolve: jest.fn().mockResolvedValue([]), isKnownType: jest.fn().mockReturnValue(true) } },
      { provide: StorageService, useValue: { isValidFileKey: jest.fn().mockReturnValue(true) } },
      {
        provide: MESSAGE_FANOUT_PROVIDER,
        useValue: {
          dispatchRealtime: jest.fn().mockResolvedValue(undefined),
          dispatchDeferred: jest.fn().mockResolvedValue(undefined),
        },
      },
    ],
  }).compile();
  return module.get(ChatMessagesService);
}

describe("chat send is idempotent under a client key", () => {
  it("a retry with a seen client key returns the original message and inserts nothing", async () => {
    const db = makeDb({ replayed: existing });
    const service = await build(db);

    const result = await service.send(CHANNEL, USER, ORG, { content: "hello", clientKey: CLIENT_KEY });

    expect(result).toEqual(existing);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("the replay lookup is bound to org, channel and key — never key alone", async () => {
    const db = makeDb({ replayed: existing });
    const service = await build(db);

    await service.send(CHANNEL, USER, ORG, { content: "hello", clientKey: CLIENT_KEY });

    const query = db.query as { chatMessages: { findFirst: jest.Mock } };
    const where = query.chatMessages.findFirst.mock.calls[0]?.[0]?.where;
    const values = sqlValues(where);
    expect(values).toContain(ORG);
    expect(values).toContain(CHANNEL);
    expect(values).toContain(CLIENT_KEY);
  });

  it("a first send persists the client key and guards the insert with the composite target", async () => {
    const db = makeDb({ replayed: undefined });
    const service = await build(db);

    await service.send(CHANNEL, USER, ORG, { content: "hello", clientKey: CLIENT_KEY });

    const values = (db.values as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values["clientKey"]).toBe(CLIENT_KEY);
    const conflict = (db.onConflictDoNothing as jest.Mock).mock.calls[0]?.[0] as { target: unknown[] };
    expect(conflict).toBe(CHAT_MESSAGE_CLIENT_KEY_CONFLICT);
    expect(conflict.target).toEqual([chatMessages.orgId, chatMessages.channelId, chatMessages.clientKey]);
  });

  it("two retries racing past the pre-check: the loser replays the winner instead of failing", async () => {
    // The pre-check misses, the insert conflicts and returns no row — exactly what the
    // second of two concurrent retries observes.
    const db = makeDb({ replayed: undefined, inserted: [] });
    const query = db.query as { chatMessages: { findFirst: jest.Mock } };
    query.chatMessages.findFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(existing);
    const service = await build(db);

    const result = await service.send(CHANNEL, USER, ORG, { content: "hello", clientKey: CLIENT_KEY });

    expect(result).toEqual(existing);
  });

  it("a send with no client key keeps the previous behaviour and still inserts", async () => {
    const db = makeDb({ replayed: undefined });
    const service = await build(db);

    await service.send(CHANNEL, USER, ORG, { content: "hello" });

    const query = db.query as { chatMessages: { findFirst: jest.Mock } };
    expect(query.chatMessages.findFirst).not.toHaveBeenCalled();
    const values = (db.values as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values["clientKey"]).toBeNull();
  });
});

function sqlValues(where: unknown, seen = new Set<object>()): unknown[] {
  if (where === null || where === undefined || typeof where !== "object") return [where];
  if (Array.isArray(where)) return where.flatMap((v) => sqlValues(v, seen));
  if (seen.has(where)) return [];
  seen.add(where);
  const rec = where as Record<string, unknown>;
  return [
    ...(Array.isArray(rec.queryChunks) ? sqlValues(rec.queryChunks, seen) : []),
    ...("value" in rec ? sqlValues(rec.value, seen) : []),
  ];
}
