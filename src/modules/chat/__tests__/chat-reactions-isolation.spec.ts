import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AblyService } from "../../realtime/ably.service";
import { ChatReactionsService } from "../chat-reactions.service";

function flatValues(where: unknown, seen = new Set<object>()): unknown[] {
  if (where === null || where === undefined || typeof where !== "object") return [where];
  if (Array.isArray(where)) return where.flatMap((v) => flatValues(v, seen));
  if (seen.has(where as object)) return [];
  seen.add(where as object);
  const rec = where as Record<string, unknown>;
  return [
    ...(Array.isArray(rec.queryChunks) ? flatValues(rec.queryChunks, seen) : []),
    ...("value" in rec ? flatValues(rec.value, seen) : []),
  ];
}

const ORG_A = "org-a";
const ORG_B = "org-b";
const USER_A = "user-a";
const MEMBERSHIP_A = 11;
const CHANNEL_ID = 42;
const MESSAGE_ID = 99;
const EMOJI = "👍";

const mockAbly = { publishChatEvent: jest.fn().mockResolvedValue(undefined) };

function makeDb(overrides: Partial<{
  membershipId: number | null;
  channelMember: { id: number } | null;
  channel: { id: number; isPrivate: boolean } | null;
  message: { id: number } | null;
  reactions: unknown[];
}> = {}) {
  const {
    membershipId = MEMBERSHIP_A,
    channelMember = { id: MEMBERSHIP_A },
    channel = { id: CHANNEL_ID, isPrivate: false },
    message = { id: MESSAGE_ID },
    reactions = [],
  } = overrides;
  return {
    query: {
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(membershipId !== null ? { id: membershipId } : null) },
      chatChannels: { findFirst: jest.fn().mockResolvedValue(channel) },
      chatChannelMembers: { findFirst: jest.fn().mockResolvedValue(channelMember) },
      chatMessageReactions: { findMany: jest.fn().mockResolvedValue(reactions) },
    },
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(message ? [message] : []),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockReturnThis(),
  };
}

describe("ChatReactionsService — cross-tenant isolation", () => {
  let service: ChatReactionsService;

  async function buildService(db: ReturnType<typeof makeDb>): Promise<ChatReactionsService> {
    const module = await Test.createTestingModule({
      providers: [
        ChatReactionsService,
        { provide: DRIZZLE, useValue: db },
        { provide: AblyService, useValue: mockAbly },
      ],
    }).compile();
    return module.get(ChatReactionsService);
  }

  beforeEach(() => jest.clearAllMocks());

  describe("addReaction", () => {
    it("DENY: no organization membership means no reaction can be added", async () => {
      const db = makeDb({ membershipId: null, channelMember: null });
      service = await buildService(db);
      await expect(
        service.addReaction(CHANNEL_ID, MESSAGE_ID, USER_A, ORG_B, EMOJI),
      ).rejects.toThrow(ForbiddenException);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("DENY: attacker org member cannot react in a different org's channel (channel membership check)", async () => {
      const db = makeDb({ channelMember: null });
      service = await buildService(db);
      await expect(
        service.addReaction(CHANNEL_ID, MESSAGE_ID, USER_A, ORG_B, EMOJI),
      ).rejects.toThrow(ForbiddenException);
      const channelCall = db.query.chatChannelMembers.findFirst.mock.calls[0]?.[0];
      expect(flatValues(channelCall?.where)).toContain(ORG_B);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("DENY: message not found in this org returns NotFoundException before insert", async () => {
      const db = makeDb({ message: null });
      service = await buildService(db);
      await expect(
        service.addReaction(CHANNEL_ID, MESSAGE_ID, USER_A, ORG_A, EMOJI),
      ).rejects.toThrow(NotFoundException);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("CONTROL: valid member can add a reaction (INSERT ON CONFLICT DO NOTHING)", async () => {
      const db = makeDb();
      service = await buildService(db);
      const result = await service.addReaction(CHANNEL_ID, MESSAGE_ID, USER_A, ORG_A, EMOJI);
      expect(result).toHaveProperty("reactions");
      expect(db.insert).toHaveBeenCalled();
      expect(db.onConflictDoNothing).toHaveBeenCalled();
    });

    it("CONTROL: calling addReaction twice is idempotent (ON CONFLICT DO NOTHING is used)", async () => {
      const db = makeDb();
      service = await buildService(db);
      await service.addReaction(CHANNEL_ID, MESSAGE_ID, USER_A, ORG_A, EMOJI);
      await service.addReaction(CHANNEL_ID, MESSAGE_ID, USER_A, ORG_A, EMOJI);
      expect(db.insert).toHaveBeenCalledTimes(2);
      expect(db.onConflictDoNothing).toHaveBeenCalledTimes(2);
    });
  });

  describe("removeReaction", () => {
    it("DENY: no organization membership means no reaction can be removed", async () => {
      const db = makeDb({ membershipId: null, channelMember: null });
      service = await buildService(db);
      await expect(
        service.removeReaction(CHANNEL_ID, MESSAGE_ID, USER_A, ORG_B, EMOJI),
      ).rejects.toThrow(ForbiddenException);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it("DENY: attacker org member cannot remove reactions in a different org's channel", async () => {
      const db = makeDb({ channelMember: null });
      service = await buildService(db);
      await expect(
        service.removeReaction(CHANNEL_ID, MESSAGE_ID, USER_A, ORG_B, EMOJI),
      ).rejects.toThrow(ForbiddenException);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it("CONTROL: valid member can remove a reaction (idempotent DELETE)", async () => {
      const db = makeDb();
      service = await buildService(db);
      const result = await service.removeReaction(CHANNEL_ID, MESSAGE_ID, USER_A, ORG_A, EMOJI);
      expect(result).toHaveProperty("reactions");
      expect(db.delete).toHaveBeenCalled();
    });

    it("CONTROL: removing a non-existent reaction is a no-op — returns reactions without throwing (idempotent)", async () => {
      const db = makeDb({ reactions: [] });
      const deleteWhere = jest.fn().mockResolvedValue(undefined);
      (db.delete as jest.Mock).mockReturnValue({ where: deleteWhere });
      service = await buildService(db);
      const result = await service.removeReaction(CHANNEL_ID, MESSAGE_ID, USER_A, ORG_A, EMOJI);
      expect(result).toHaveProperty("reactions");
      expect(deleteWhere).toHaveBeenCalledTimes(1);
    });
  });
});
