import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException, InternalServerErrorException } from "@nestjs/common";
import { ChatSummarizeService } from "./chat-summarize.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { ModuleRef } from "@nestjs/core";

const ACTOR = { orgId: "org-1", userId: "user-1" };
const CHANNEL_ID = 42;

const makeMember = () => ({ id: 1, channelId: CHANNEL_ID, userId: ACTOR.userId, role: "MEMBER" });

const makeMessages = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    content: `message ${i + 1}`,
    createdAt: new Date(Date.now() + i * 1000),
    senderName: "Alice",
    senderEmail: "alice@example.com",
  }));

function buildDb(memberResult: unknown, messagesResult: unknown[]) {
  const chain: {
    leftJoin: jest.Mock;
    where: jest.Mock;
    orderBy: jest.Mock;
    limit: jest.Mock;
  } = {
    leftJoin: jest.fn(() => chain),
    where: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn().mockResolvedValue(messagesResult),
  };
  return {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: 1 }),
      },
      chatChannels: {
        findFirst: jest.fn().mockResolvedValue({ id: 5, isPrivate: false }),
      },
      chatChannelMembers: {
        findFirst: jest.fn().mockResolvedValue(memberResult),
      },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue(chain),
    }),
  };
}

describe("ChatSummarizeService", () => {
  let service: ChatSummarizeService;
  let db: ReturnType<typeof buildDb>;
  let aiGateway: { invokeText: jest.Mock };

  async function init(memberResult: unknown, messagesResult: unknown[]) {
    db = buildDb(memberResult, messagesResult);
    aiGateway = { invokeText: jest.fn() };

    const moduleRef = { get: jest.fn().mockReturnValue(aiGateway) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatSummarizeService,
        { provide: DRIZZLE, useValue: db },
        { provide: ModuleRef, useValue: moduleRef },
      ],
    }).compile();

    service = module.get(ChatSummarizeService);
  }

  it("throws ForbiddenException when user is not a member", async () => {
    await init(null, []);
    await expect(service.summarize(CHANNEL_ID, ACTOR)).rejects.toThrow(ForbiddenException);
  });

  it("throws BadRequestException when channel has no messages", async () => {
    await init(makeMember(), []);
    await expect(service.summarize(CHANNEL_ID, ACTOR)).rejects.toThrow(BadRequestException);
  });

  it("returns summary on success", async () => {
    await init(makeMember(), makeMessages(3));
    aiGateway.invokeText.mockResolvedValue({ ok: true, data: "Great summary", model: "fast", latencyMs: 100, correlationId: "x", usage: {} });
    const result = await service.summarize(CHANNEL_ID, ACTOR);
    expect(result).toEqual({ summary: "Great summary" });
  });

  it("throws InternalServerErrorException when AI fails", async () => {
    await init(makeMember(), makeMessages(2));
    aiGateway.invokeText.mockResolvedValue({ ok: false, kind: "provider_unavailable", message: "AI down", correlationId: "x" });
    await expect(service.summarize(CHANNEL_ID, ACTOR)).rejects.toThrow(InternalServerErrorException);
  });

  it("never posts a message — invokeText is called, not sendMessage", async () => {
    await init(makeMember(), makeMessages(2));
    aiGateway.invokeText.mockResolvedValue({ ok: true, data: "summary", model: "fast", latencyMs: 50, correlationId: "x", usage: {} });
    await service.summarize(CHANNEL_ID, ACTOR);
    expect(aiGateway.invokeText).toHaveBeenCalledTimes(1);
    expect((db as unknown as Record<string, unknown>).insert).toBeUndefined();
  });

  it("caps messages at 50", async () => {
    await init(makeMember(), makeMessages(50));
    aiGateway.invokeText.mockResolvedValue({ ok: true, data: "summary", model: "fast", latencyMs: 50, correlationId: "x", usage: {} });
    await service.summarize(CHANNEL_ID, ACTOR);
    const limitCall = db.select().from({} as never).leftJoin({} as never, {} as never).where({} as never).orderBy({} as never).limit as jest.Mock;
    expect(limitCall).toHaveBeenCalledWith(50);
  });
});
