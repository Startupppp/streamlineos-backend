import { ForbiddenException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { REDIS } from "../../common/cache/cache.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { ChatTypingService } from "./chat-typing.service";

const db = {
  query: {
    chatChannelMembers: { findFirst: jest.fn() },
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
    db.query.chatChannelMembers.findFirst.mockResolvedValue(undefined);

    await expect(service.setTyping(12, "user-2")).rejects.toThrow(ForbiddenException);
    expect(redis.hset).not.toHaveBeenCalled();
  });

  it("rejects typing reads when the actor is not in the channel", async () => {
    db.query.chatChannelMembers.findFirst.mockResolvedValue(undefined);

    await expect(service.getTyping(12, "user-2")).rejects.toThrow(ForbiddenException);
    expect(redis.hgetall).not.toHaveBeenCalled();
  });
});
