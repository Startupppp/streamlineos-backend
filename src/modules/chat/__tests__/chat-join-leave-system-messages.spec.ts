import { ChatChannelMembersImplementation } from "../chat-channel-members-implementation";
import { ChatMessagesService } from "../chat-messages.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { Db } from "../../../db/drizzle.module";
import type { EntityReferenceService } from "../../entity-reference/entity-reference.types";
import type { EntityActor } from "../../entity-reference/entity-reference.types";

/**
 * `joinOpenChannel` and `leaveChannel` must write a system message after a
 * successful membership change so the channel activity feed shows join/leave
 * events.
 *
 * Neither method called `sendSystemMessage`; the service existed but was not
 * wired. Activity feeds showed no events when users joined or left public
 * channels.
 */

jest.mock("../../../common/outbox/outbox-writer", () => ({
  OutboxWriter: { emit: jest.fn() },
}));
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(
    async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
  ),
}));

const ORG = "org-1";
const CHANNEL = 7;
const USER = "user-42";

function actor(): EntityActor {
  return {
    orgId: ORG,
    userId: USER,
    membershipId: 99,
    isOrgOwner: false,
    permissions: [],
  } as unknown as EntityActor;
}

function makeJoinDb(alreadyMember: boolean) {
  return {
    query: {
      chatChannels: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: CHANNEL, type: "PUBLIC", entityType: null, entityId: null }),
      },
      chatChannelMembers: {
        findFirst: jest.fn().mockResolvedValue(alreadyMember ? { id: 2 } : null),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: 55, isOwner: false }),
      },
    },
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
      }),
    }),
  } as unknown as Db;
}

function makeLeaveDb() {
  return {
    query: {
      chatChannels: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: CHANNEL, isPrivate: false, entityType: null, entityId: null }),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: 55, isOwner: false }),
      },
      chatChannelMembers: {
        findFirst: jest.fn().mockResolvedValue({ role: "MEMBER" }),
      },
    },
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
  } as unknown as Db;
}

function makeMsgService() {
  return { sendSystemMessage: jest.fn().mockResolvedValue(undefined) } as unknown as ChatMessagesService;
}

function makeEntities(): EntityReferenceService {
  return {} as unknown as EntityReferenceService;
}

beforeEach(() => jest.clearAllMocks());

describe("joinOpenChannel writes a system message", () => {
  it("sends a system message when a new member joins", async () => {
    const db = makeJoinDb(false);
    const msgs = makeMsgService();
    const service = new ChatChannelMembersImplementation(db, makeEntities(), msgs);

    await service.joinOpenChannel(CHANNEL, actor());

    expect(msgs.sendSystemMessage).toHaveBeenCalledWith(
      CHANNEL,
      USER,
      ORG,
      expect.any(String),
      expect.any(Object),
    );
  });

  it("does not send a system message when the user is already a member", async () => {
    const db = makeJoinDb(true);
    const msgs = makeMsgService();
    const service = new ChatChannelMembersImplementation(db, makeEntities(), msgs);

    await service.joinOpenChannel(CHANNEL, actor());

    expect(msgs.sendSystemMessage).not.toHaveBeenCalled();
  });
});

describe("leaveChannel writes a system message", () => {
  it("sends a system message when a member leaves", async () => {
    const db = makeLeaveDb();
    const msgs = makeMsgService();
    const service = new ChatChannelMembersImplementation(db, makeEntities(), msgs);

    await service.leaveChannel(CHANNEL, USER, ORG);

    expect(msgs.sendSystemMessage).toHaveBeenCalledWith(
      CHANNEL,
      USER,
      ORG,
      expect.any(String),
      expect.any(Object),
    );
  });
});
