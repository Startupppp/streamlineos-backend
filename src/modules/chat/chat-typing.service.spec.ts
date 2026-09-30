import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { REDIS } from "../../common/cache/cache.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { ChatTypingService } from "./chat-typing.service";

const db = {
  query: {
    chatChannels: { findFirst: jest.fn() },
    chatChannelMembers: { findFirst: jest.fn() },
    organizationMembers: { findFirst: jest.fn() },
    users: { findFirst: jest.fn() },
  },
};

const redis = {
  expire: jest.fn(),
  hgetall: jest.fn(),
  hset: jest.fn(),
};

describe("ChatTypingService", () => {
  let service: ChatTypingService;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatTypingService,
        { provide: DRIZZLE, useValue: db },
        { provide: REDIS, useValue: redis },
      ],
    }).compile();
    service = module.get(ChatTypingService);
  });

  it("rejects a typing mutation when the actor is not in the channel", async () => {
    db.query.chatChannels.findFirst.mockResolvedValue({ id: 12, isPrivate: false });
    db.query.organizationMembers.findFirst.mockResolvedValue(null);
    db.query.chatChannelMembers.findFirst.mockResolvedValue(undefined);

    await expect(service.setTyping(12, "org-1", "user-2")).rejects.toThrow(ForbiddenException);
    expect(redis.hset).not.toHaveBeenCalled();
  });

  it("rejects typing reads when the actor is not in the channel", async () => {
    db.query.chatChannels.findFirst.mockResolvedValue({ id: 12, isPrivate: false });
    db.query.organizationMembers.findFirst.mockResolvedValue(null);
    db.query.chatChannelMembers.findFirst.mockResolvedValue(undefined);

    await expect(service.getTyping(12, "org-1", "user-2")).rejects.toThrow(ForbiddenException);
    expect(redis.hgetall).not.toHaveBeenCalled();
  });

  it("refuses a channel this organization does not hold with NotFound, never Forbidden", async () => {
    db.query.chatChannels.findFirst.mockResolvedValue(undefined);
    db.query.organizationMembers.findFirst.mockResolvedValue({ id: 1 });
    db.query.chatChannelMembers.findFirst.mockResolvedValue(undefined);

    const thrown = await service.getTyping(12, "org-1", "user-2").catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(thrown).not.toBeInstanceOf(ForbiddenException);
    expect(redis.hgetall).not.toHaveBeenCalled();
  });

  it("a private channel does not confirm its own existence to a non-member", async () => {
    db.query.chatChannels.findFirst.mockResolvedValue({ id: 12, isPrivate: true });
    db.query.organizationMembers.findFirst.mockResolvedValue({ id: 1 });
    db.query.chatChannelMembers.findFirst.mockResolvedValue(undefined);

    await expect(service.setTyping(12, "org-1", "user-2")).rejects.toThrow(NotFoundException);
  });
});

describe("ChatTypingService without Upstash", () => {
  it("keeps typing state in-process so a single instance still shows typers", async () => {
    const module = await Test.createTestingModule({
      providers: [
        ChatTypingService,
        { provide: DRIZZLE, useValue: db },
        { provide: REDIS, useValue: null },
      ],
    }).compile();
    const service = module.get(ChatTypingService);
    db.query.chatChannels.findFirst.mockResolvedValue({ id: 12, isPrivate: false });
    db.query.organizationMembers.findFirst.mockResolvedValue({ id: 1 });
    db.query.chatChannelMembers.findFirst.mockResolvedValue({ id: 1 });
    db.query.users.findFirst.mockResolvedValue({ name: "Ann" });

    await service.setTyping(12, "org-1", "user-1");

    await expect(service.getTyping(12, "org-1", "user-2")).resolves.toEqual([{ userId: "user-1", name: "Ann" }]);
    await expect(service.getTyping(12, "org-1", "user-1")).resolves.toEqual([]);
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 5_000);
    await expect(service.getTyping(12, "org-1", "user-2")).resolves.toEqual([]);
    jest.restoreAllMocks();
  });
});
