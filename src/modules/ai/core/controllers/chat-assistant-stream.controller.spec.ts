import type { Request, Response } from "express";
import {
  ForbiddenException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { z } from "zod";
import { ChatAssistantController } from "./chat-assistant.controller";
import { chatRequestSchema } from "../dto/request.schemas";
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

const BODY: z.infer<typeof chatRequestSchema> = { messages: [{ role: "user", content: "hi" }] };

function closeEmitter() {
  const listeners = new Set<() => void>();
  return {
    on: (_event: string, listener: () => void) => listeners.add(listener),
    off: (_event: string, listener: () => void) => listeners.delete(listener),
    emitClose: () => {
      for (const l of [...listeners]) l();
    },
  };
}

/**
 * `complete: true` is what a real Express request looks like by the time a
 * handler runs — the body is already drained and the request stream is closed.
 * A fake without it cannot tell a hang-up from a normal request.
 */
function makeRequest(): Request & { emitClose: () => void } {
  return { ...closeEmitter(), complete: true } as unknown as Request & { emitClose: () => void };
}

function makeResponse(): Response & {
  end: jest.Mock;
  destroy: jest.Mock;
  emitClose: () => void;
} {
  return {
    ...closeEmitter(),
    writableEnded: false,
    end: jest.fn(),
    destroy: jest.fn(),
  } as unknown as Response & { end: jest.Mock; destroy: jest.Mock; emitClose: () => void };
}

function makeController(processChat: jest.Mock, aiChat = true) {
  const controller = new ChatAssistantController(
    { processChat } as never,
    {} as never,
    { getFlags: jest.fn().mockResolvedValue({ aiChat }) } as never,
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
  /**
   * The handler must still resolve — a rejected pipe promise here would be an
   * unhandled rejection, which is what this test was written for. What it must
   * NOT do is end the response cleanly: `res.end()` sends the terminating chunk
   * and the client reads the truncated answer as a completed one. The fault is
   * signalled by destroying the response instead
   * (`ai-stream-fault-is-visible.spec.ts` proves what that means over a socket).
   */
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
    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(res.end).not.toHaveBeenCalled();
  });
});

describe("ChatAssistantController — cancellation reaches the service", () => {
  it("hands processChat a signal that aborts on a client disconnect mid-flight", async () => {
    let signal: AbortSignal | undefined;
    const req = makeRequest();
    const res = makeResponse();
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
            res.emitClose();
            return Promise.resolve({
              pipeTextStreamToResponse: jest.fn().mockResolvedValue(undefined),
            });
          },
        ),
    );

    await controller.chatAssistant(req, BODY, ACTOR, res);

    expect(signal?.aborted).toBe(true);
  });

  it("does NOT abort because the request body was fully received", async () => {
    let signal: AbortSignal | undefined;
    const req = makeRequest();
    const res = makeResponse();
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

    await controller.chatAssistant(req, BODY, ACTOR, res);

    expect(signal?.aborted).toBe(false);
  });
});
