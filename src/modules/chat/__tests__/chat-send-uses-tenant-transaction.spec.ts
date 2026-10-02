jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest
    .fn()
    .mockImplementation(
      (_db: unknown, fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) => fn(_db),
    ),
  runInNewTenantTransaction: jest
    .fn()
    .mockImplementation(
      (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
    ),
}));

import { Test } from "@nestjs/testing";
import { ChatMessagesService } from "../chat-messages.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CacheService } from "../../../common/cache/cache.service";
import { AblyService } from "../../realtime/ably.service";
import { ChatReplyRemindersService } from "../chat-reply-reminders.service";
import { ChatOrgSettingsService } from "../chat-org-settings.service";
import { StorageService } from "../../storage/storage.service";
import { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import { MESSAGE_FANOUT_PROVIDER } from "../message-fanout.interface";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

const ORG = "org-send-test";
const CHANNEL = 3;
const USER = "user-send-1";

function makeChain<T>(result: T) {
  const chain: Record<string, unknown> = {};
  for (const m of [
    "from",
    "where",
    "set",
    "values",
    "limit",
    "returning",
    "onConflictDoNothing",
    "leftJoin",
    "innerJoin",
    "orderBy",
  ]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain["then"] = (
    resolve: (v: T) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function makeDb() {
  const createdMsg = {
    id: 1,
    createdAt: new Date(),
    orgId: ORG,
    channelId: CHANNEL,
    senderMembershipId: 1,
    content: "hello",
    replyToId: null,
    metadata: null,
    clientKey: null,
    channelPosition: 1,
    isDeleted: false,
    isEdited: false,
    messageType: "text",
    actionStatus: null,
    updatedAt: new Date(),
  };

  const db: Record<string, unknown> = {
    query: {
      chatChannels: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: CHANNEL, isPrivate: false, entityType: null, entityId: null }),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: 1, isOwner: false }),
      },
      chatChannelMembers: {
        findFirst: jest.fn().mockResolvedValue({ role: "MEMBER" }),
      },
    },
    select: jest
      .fn()
      .mockReturnValueOnce(makeChain([{ id: CHANNEL, type: "GROUP", isArchived: false }]))
      .mockReturnValueOnce(makeChain([{ name: "Alice", image: null }])),
    update: jest
      .fn()
      .mockReturnValueOnce(makeChain([{ position: 1 }]))
      .mockReturnValueOnce(makeChain(undefined))
      .mockReturnValueOnce(makeChain(undefined)),
    insert: jest
      .fn()
      .mockReturnValueOnce(makeChain([createdMsg]))
      .mockReturnValueOnce(makeChain(undefined)),
    transaction: jest
      .fn()
      .mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };

  return db;
}

async function buildService(db: Record<string, unknown>) {
  const module = await Test.createTestingModule({
    providers: [
      ChatMessagesService,
      { provide: DRIZZLE, useValue: db },
      { provide: CacheService, useValue: {} },
      { provide: AblyService, useValue: {} },
      {
        provide: ChatReplyRemindersService,
        useValue: { scheduleForMessage: jest.fn().mockResolvedValue(undefined) },
      },
      { provide: ChatOrgSettingsService, useValue: {} },
      { provide: StorageService, useValue: {} },
      {
        provide: EntityReferenceService,
        useValue: { resolve: jest.fn().mockResolvedValue([{ status: "resolved" }]) },
      },
      {
        provide: MESSAGE_FANOUT_PROVIDER,
        useValue: { dispatchRealtime: jest.fn().mockResolvedValue(undefined) },
      },
    ],
  }).compile();
  return module.get(ChatMessagesService);
}

describe("ChatMessagesService.send — tenant transaction wrapping", () => {
  beforeEach(() => jest.clearAllMocks());

  it("send wraps the write path in runInTenantTransaction with the actor orgId", async () => {
    const db = makeDb();
    const service = await buildService(db);

    await service.send(CHANNEL, USER, ORG, { content: "hello" });

    expect(runInTenantTransaction).toHaveBeenCalledWith(
      db,
      expect.any(Function),
      { orgId: ORG },
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("CONTROL: send returns the created message when the transaction succeeds", async () => {
    const db = makeDb();
    const service = await buildService(db);

    const result = await service.send(CHANNEL, USER, ORG, { content: "hello" });

    expect(result).toMatchObject({ id: 1, content: "hello", orgId: ORG });
  });
});
