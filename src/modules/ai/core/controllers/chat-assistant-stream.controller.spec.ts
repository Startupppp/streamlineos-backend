import type { Request, Response } from "express";
import {
  ForbiddenException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { ChatAssistantController } from "./chat-assistant.controller";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

const ACTOR: CurrentUserContext = {
  userId: "user_1",
  orgId: "org_1",
  role: "ADMIN",
  permissions: [],
  isOrgOwner: false,
  sessionId: "sess_1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
} as unknown as CurrentUserContext;

const BODY = { messages: [{ role: "user", content: "hi" }] };

function makeRequest(): Request & { emitClose: () => void } {
  const listeners = new Set<() => void>();
  return {
    on: (_event: string, listener: () => void) => listeners.add(listener),
    off: (_event: string, listener: () => void) => listeners.delete(listener),
    emitClose: () => {
      for (const l of [...listeners]) l();
    },
  } as unknown as Request & { emitClose: () => void };
}

function makeResponse(): Response & { end: jest.Mock } {
  return { writableEnded: false, end: jest.fn() } as unknown as Response & { end: jest.Mock };
}

function makeController(processChat: jest.Mock, aiChat = true) {
  const controller = new ChatAssistantController(
    { processChat } as never,
    {} as never,
    { getFlags: jest.fn().mockResolvedValue({ aiChat }) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return controller;
}

describe("ChatAssistantController — a stream failure keeps its status", () => {
  it("passes the circuit breaker's 503 through rather than reporting a 500", async () => {
    const controller = makeController(
      jest.fn().mockRejectedValue(
        new ServiceUnavailableException("AI chat provider is temporarily unavailable"),
      ),
    );

    await expect(
      controller.chatAssistant(makeRequest(), BODY, ACTOR, makeResponse()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("passes the concurrency cap's 503 through", async () => {
    const controller = makeController(
      jest
        .fn()
        .mockRejectedValue(
          new ServiceUnavailableException("Too many concurrent AI requests for this organization"),
        ),
    );

    await expect(
      controller.chatAssistant(makeRequest(), BODY, ACTOR, makeResponse()),
    ).rejects.toThrow("Too many concurrent AI requests");
  });

  it("passes the credit ledger's 402 through", async () => {
    const controller = makeController(
      jest.fn().mockRejectedValue(new InsufficientAiCreditsException({ message: "out of credits" })),
    );

    await expect(
      controller.chatAssistant(makeRequest(), BODY, ACTOR, makeResponse()),
    ).rejects.toMatchObject({ status: 402 });
  });

  it("still hides an unexpected fault behind a generic 500", async () => {
    const controller = makeController(jest.fn().mockRejectedValue(new Error("boom")));

    await expect(
      controller.chatAssistant(makeRequest(), BODY, ACTOR, makeResponse()),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it("refuses with 403 before touching the service when the org has AI chat off", async () => {
    const processChat = jest.fn();
    const controller = makeController(processChat, false);

    await expect(
      controller.chatAssistant(makeRequest(), BODY, ACTOR, makeResponse()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(processChat).not.toHaveBeenCalled();
  });
});

describe("ChatAssistantController — the pipe promise is awaited", () => {
  it("does not reject the handler when the provider faults after headers were sent", async () => {
    const controller = makeController(
      jest.fn().mockResolvedValue({
        pipeTextStreamToResponse: jest.fn().mockRejectedValue(new Error("upstream 503")),
      }),
    );
    const res = makeResponse();

    await expect(
      controller.chatAssistant(makeRequest(), BODY, ACTOR, res),
    ).resolves.toBeUndefined();
    expect(res.end).toHaveBeenCalledTimes(1);
  });
});

describe("ChatAssistantController — cancellation reaches the service", () => {
  it("hands processChat a signal that aborts on a client disconnect mid-flight", async () => {
    let signal: AbortSignal | undefined;
    const req = makeRequest();
    const controller = makeController(
      jest
        .fn()
        .mockImplementation(
          (
            _messages: unknown,
            _actor: unknown,
            _conversationId: unknown,
            _persona: unknown,
            s: AbortSignal,
          ) => {
            signal = s;
            req.emitClose();
            return Promise.resolve({
              pipeTextStreamToResponse: jest.fn().mockResolvedValue(undefined),
            });
          },
        ),
    );

    await controller.chatAssistant(req, BODY, ACTOR, makeResponse());

    expect(signal?.aborted).toBe(true);
  });
});
