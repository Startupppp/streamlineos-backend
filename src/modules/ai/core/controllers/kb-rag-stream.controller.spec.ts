import type { Request, Response } from "express";
import {
  InternalServerErrorException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { KbRagController } from "./kb-rag.controller";
import type { KbRagService } from "../services/kb-rag.service";

const BODY = { org: "org_1", question: "How do I reset my password?" };

const SOURCES = [
  {
    articleId: 10,
    title: "Getting Started",
    slug: "getting-started",
    attachmentId: null,
    attachmentName: null,
    similarity: 0.85,
  },
];

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

function makeResponse(): Response & { writeHead: jest.Mock; end: jest.Mock; emitClose: () => void } {
  return {
    ...closeEmitter(),
    writableEnded: false,
    writeHead: jest.fn(),
    end: jest.fn(),
  } as unknown as Response & { writeHead: jest.Mock; end: jest.Mock; emitClose: () => void };
}

function makeController(overrides: Partial<KbRagService> = {}) {
  const kbRag = {
    isEmbeddingConfigured: jest.fn().mockReturnValue(true),
    answerQuestion: jest.fn(),
    streamAnswer: jest.fn(),
    ...overrides,
  };
  return { controller: new KbRagController(kbRag as unknown as KbRagService), kbRag };
}

describe("KbRagController.streamAsk — citations reach the client", () => {
  it("emits the retrieved sources as a header before the body, so a truncated stream keeps them", async () => {
    const pipe = jest.fn().mockResolvedValue(undefined);
    const { controller } = makeController({
      streamAnswer: jest.fn().mockResolvedValue({
        hasContext: true,
        sources: SOURCES,
        stream: { pipeTextStreamToResponse: pipe },
      }),
    } as unknown as Partial<KbRagService>);
    const res = makeResponse();

    await controller.streamAsk(makeRequest(), BODY, res);

    const init = pipe.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(JSON.parse(decodeURIComponent(init.headers["x-kb-sources"] as string))).toEqual(SOURCES);
    expect(init.headers["access-control-expose-headers"]).toBe("x-kb-sources");
  });

  it("sends no source header when retrieval produced none", async () => {
    const pipe = jest.fn().mockResolvedValue(undefined);
    const { controller } = makeController({
      streamAnswer: jest.fn().mockResolvedValue({
        hasContext: true,
        sources: [],
        stream: { pipeTextStreamToResponse: pipe },
      }),
    } as unknown as Partial<KbRagService>);

    await controller.streamAsk(makeRequest(), BODY, makeResponse());

    expect(pipe).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it("answers the no-context case as plain text without ever opening a stream", async () => {
    const { controller } = makeController({
      streamAnswer: jest
        .fn()
        .mockResolvedValue({ hasContext: false, answer: "nothing found", sources: [] }),
    } as unknown as Partial<KbRagService>);
    const res = makeResponse();

    await controller.streamAsk(makeRequest(), BODY, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "content-type": "text/plain; charset=utf-8",
    });
    expect(res.end).toHaveBeenCalledWith("nothing found");
  });
});

describe("KbRagController.streamAsk — failures keep their status", () => {
  it("passes the breaker's 503 through instead of flattening it to 500", async () => {
    const { controller } = makeController({
      streamAnswer: jest
        .fn()
        .mockRejectedValue(new ServiceUnavailableException("AI assistant is temporarily unavailable")),
    } as unknown as Partial<KbRagService>);

    await expect(controller.streamAsk(makeRequest(), BODY, makeResponse())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("passes the credit ledger's 402 through, so the caller can tell 'top up' from 'we broke'", async () => {
    const { controller } = makeController({
      streamAnswer: jest
        .fn()
        .mockRejectedValue(new InsufficientAiCreditsException({ message: "out of credits" })),
    } as unknown as Partial<KbRagService>);

    await expect(controller.streamAsk(makeRequest(), BODY, makeResponse())).rejects.toMatchObject({
      status: 402,
    });
  });

  it("still hides an unexpected fault behind a generic 500", async () => {
    const { controller } = makeController({
      streamAnswer: jest.fn().mockRejectedValue(new Error("postgres://secret@host/db")),
    } as unknown as Partial<KbRagService>);

    await expect(controller.streamAsk(makeRequest(), BODY, makeResponse())).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it("does not reject the handler when the provider faults mid-stream", async () => {
    const { controller } = makeController({
      streamAnswer: jest.fn().mockResolvedValue({
        hasContext: true,
        sources: [],
        stream: {
          pipeTextStreamToResponse: jest.fn().mockRejectedValue(new Error("upstream 503")),
        },
      }),
    } as unknown as Partial<KbRagService>);

    await expect(
      controller.streamAsk(makeRequest(), BODY, makeResponse()),
    ).resolves.toBeUndefined();
  });
});

describe("KbRagController.streamAsk — cancellation reaches the service", () => {
  it("stops listening once the handler has returned, so a completed request aborts nothing", async () => {
    let signal: AbortSignal | undefined;
    const { controller } = makeController({
      streamAnswer: jest.fn().mockImplementation((_opts: unknown, s: AbortSignal) => {
        signal = s;
        return Promise.resolve({
          hasContext: true,
          sources: [],
          stream: { pipeTextStreamToResponse: jest.fn().mockResolvedValue(undefined) },
        });
      }),
    } as unknown as Partial<KbRagService>);
    const req = makeRequest();
    const res = makeResponse();

    await controller.streamAsk(req, BODY, res);

    expect(signal?.aborted).toBe(false);
    req.emitClose();
    res.emitClose();
    expect(signal?.aborted).toBe(false);
  });

  it("aborts the in-flight signal when the client disconnects before the response finished", async () => {
    let signal: AbortSignal | undefined;
    const req = makeRequest();
    const res = makeResponse();
    const { controller } = makeController({
      streamAnswer: jest.fn().mockImplementation((_opts: unknown, s: AbortSignal) => {
        signal = s;
        res.emitClose();
        return Promise.resolve({
          hasContext: true,
          sources: [],
          stream: { pipeTextStreamToResponse: jest.fn().mockResolvedValue(undefined) },
        });
      }),
    } as unknown as Partial<KbRagService>);

    await controller.streamAsk(req, BODY, res);

    expect(signal?.aborted).toBe(true);
  });

  it("refuses before any work when embeddings are not configured", async () => {
    const streamAnswer = jest.fn();
    const { controller } = makeController({
      isEmbeddingConfigured: jest.fn().mockReturnValue(false),
      streamAnswer,
    } as unknown as Partial<KbRagService>);

    await expect(controller.streamAsk(makeRequest(), BODY, makeResponse())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(streamAnswer).not.toHaveBeenCalled();
  });
});
