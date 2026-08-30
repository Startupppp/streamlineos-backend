import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import { ChatMessageTimelineService } from "../chat-message-timeline.service";
import type { EntityActor } from "../../entity-reference/entity-reference.types";

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

function makeActor(orgId: string, userId = USER_A, membershipId = MEMBERSHIP_A): EntityActor {
  return { orgId, userId, membershipId, isOrgOwner: false, permissions: [] } as unknown as EntityActor;
}

const mockEntities = {
  withResolvedReferences: jest.fn().mockImplementation((_actor: unknown, messages: unknown) => Promise.resolve(messages)),
};

describe("ChatMessageTimelineService — cross-tenant isolation", () => {
  let service: ChatMessageTimelineService;
  let db: {
    query: {
      chatChannelMembers: { findFirst: jest.Mock };
      chatMessages: { findMany: jest.Mock; findFirst: jest.Mock };
    };
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    db = {
      query: {
        chatChannelMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
        chatMessages: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        ChatMessageTimelineService,
        { provide: DRIZZLE, useValue: db },
        { provide: EntityReferenceService, useValue: mockEntities },
      ],
    }).compile();
    service = module.get(ChatMessageTimelineService);
  });

  describe("list", () => {
    it("DENY: attacker org cannot read messages from another org's channel", async () => {
      const actor = makeActor(ORG_B);
      await expect(service.list(CHANNEL_ID, actor, undefined, 20)).rejects.toThrow(ForbiddenException);

      const call = db.query.chatChannelMembers.findFirst.mock.calls[0]?.[0];
      expect(flatValues(call?.where)).toContain(ORG_B);
      expect(db.query.chatMessages.findMany).not.toHaveBeenCalled();
    });

    it("CONTROL: member of org-a can read their channel messages", async () => {
      const actor = makeActor(ORG_A);
      db.query.chatChannelMembers.findFirst.mockResolvedValue({ id: MEMBERSHIP_A });
      db.query.chatMessages.findMany.mockResolvedValue([]);

      const result = await service.list(CHANNEL_ID, actor, undefined, 20);
      expect(result).toHaveProperty("messages");
      const call = db.query.chatChannelMembers.findFirst.mock.calls[0]?.[0];
      expect(flatValues(call?.where)).toContain(ORG_A);
    });
  });

  describe("poll", () => {
    it("DENY: attacker org cannot poll messages from another org's channel", async () => {
      const actor = makeActor(ORG_B);
      await expect(service.poll(CHANNEL_ID, actor, new Date())).rejects.toThrow(ForbiddenException);

      const call = db.query.chatChannelMembers.findFirst.mock.calls[0]?.[0];
      expect(flatValues(call?.where)).toContain(ORG_B);
      expect(db.query.chatMessages.findMany).not.toHaveBeenCalled();
    });

    it("CONTROL: member of org-a can poll their channel", async () => {
      const actor = makeActor(ORG_A);
      db.query.chatChannelMembers.findFirst.mockResolvedValue({ id: MEMBERSHIP_A });
      db.query.chatMessages.findMany.mockResolvedValue([]);

      const result = await service.poll(CHANNEL_ID, actor, new Date());
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("listThreadReplies", () => {
    const MESSAGE_ID = 99;

    it("DENY: message not found in attacker org returns NotFoundException", async () => {
      db.query.chatMessages.findFirst.mockResolvedValue(null);
      const actor = makeActor(ORG_B);
      await expect(service.listThreadReplies(MESSAGE_ID, actor, undefined, 20)).rejects.toThrow(NotFoundException);
      expect(db.query.chatMessages.findMany).not.toHaveBeenCalled();
    });

    it("DENY: message in org-a is not accessible to a user from org-b (channel membership check)", async () => {
      db.query.chatMessages.findFirst.mockResolvedValue({ id: MESSAGE_ID, channelId: CHANNEL_ID });
      db.query.chatChannelMembers.findFirst.mockResolvedValue(undefined);
      const actor = makeActor(ORG_B);
      await expect(service.listThreadReplies(MESSAGE_ID, actor, undefined, 20)).rejects.toThrow(ForbiddenException);

      const call = db.query.chatChannelMembers.findFirst.mock.calls[0]?.[0];
      expect(flatValues(call?.where)).toContain(ORG_B);
      expect(db.query.chatMessages.findMany).not.toHaveBeenCalled();
    });

    it("CONTROL: member of org-a can read thread replies in their channel", async () => {
      db.query.chatMessages.findFirst.mockResolvedValue({ id: MESSAGE_ID, channelId: CHANNEL_ID });
      db.query.chatChannelMembers.findFirst.mockResolvedValue({ id: MEMBERSHIP_A });
      db.query.chatMessages.findMany.mockResolvedValue([]);
      const actor = makeActor(ORG_A);

      const result = await service.listThreadReplies(MESSAGE_ID, actor, undefined, 20);
      expect(result).toHaveProperty("replies");
    });
  });
});
