import type { ServerResponse } from "http";
import {
  ForbiddenException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import {
  encodeStreamSources,
  sourcesTruncatedHeaderName,
  pipeAiTextStream,
  rethrowStreamRouteError,
  type PipeableAiTextStream,
} from "./ai-stream-response";

function makeResponse(): ServerResponse & {
  writableEnded: boolean;
  end: jest.Mock;
  destroy: jest.Mock;
} {
  return {
    writableEnded: false,
    end: jest.fn(function (this: { writableEnded: boolean }) {
      this.writableEnded = true;
    }),
    destroy: jest.fn(function (this: { writableEnded: boolean }) {
      this.writableEnded = true;
    }),
  } as unknown as ServerResponse & {
    writableEnded: boolean;
    end: jest.Mock;
    destroy: jest.Mock;
  };
}

describe("pipeAiTextStream — the pipe promise is never dropped", () => {
  it("resolves normally when the stream completes", async () => {
    const res = makeResponse();
    const stream: PipeableAiTextStream = {
      pipeTextStreamToResponse: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      pipeAiTextStream(res, stream, { feature: "f", orgId: "org_1" }),
    ).resolves.toBeUndefined();
  });

  it("swallows a mid-stream provider fault instead of leaving an unhandled rejection", async () => {
    const res = makeResponse();
    const stream: PipeableAiTextStream = {
      pipeTextStreamToResponse: jest.fn().mockRejectedValue(new Error("upstream 503")),
    };
    const onFault = jest.fn();

    await expect(
      pipeAiTextStream(res, stream, { feature: "f", orgId: "org_1", onFault }),
    ).resolves.toBeUndefined();

    expect(onFault).toHaveBeenCalledWith(expect.any(Error));
  });

  /**
   * `res.end()` here was the defect: it sends the terminating chunk, so the
   * client's read loop sees a normal `done` and the frontend returns
   * `{ status: "completed", text: <partial> }` for a stream that failed. The
   * truncation has to be visible on the wire, and destroying the response is
   * how HTTP says it.
   */
  it("truncates the response the failed pipe left open rather than ending it cleanly", async () => {
    const res = makeResponse();
    const stream: PipeableAiTextStream = {
      pipeTextStreamToResponse: jest.fn().mockRejectedValue(new Error("upstream 503")),
    };

    await pipeAiTextStream(res, stream, { feature: "f", orgId: "org_1" });

    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(res.end).not.toHaveBeenCalled();
  });

  it("does not re-end a response the pipe already ended", async () => {
    const res = makeResponse();
    const stream: PipeableAiTextStream = {
      pipeTextStreamToResponse: jest.fn().mockImplementation(() => {
        res.writableEnded = true;
        return Promise.reject(new Error("upstream 503"));
      }),
    };

    await pipeAiTextStream(res, stream, { feature: "f", orgId: "org_1" });

    expect(res.end).not.toHaveBeenCalled();
    expect(res.destroy).not.toHaveBeenCalled();
  });

  it("forwards headers so metadata lands before the body", async () => {
    const res = makeResponse();
    const pipe = jest.fn().mockResolvedValue(undefined);

    await pipeAiTextStream(res, { pipeTextStreamToResponse: pipe }, {
      feature: "f",
      orgId: "org_1",
      headers: { "x-kb-sources": "abc" },
    });

    expect(pipe).toHaveBeenCalledWith(res, { headers: { "x-kb-sources": "abc" } });
  });
});

describe("rethrowStreamRouteError — a route catch must not flatten every failure to 500", () => {
  it("preserves the breaker's 503", () => {
    const thrown = new ServiceUnavailableException("AI chat provider is temporarily unavailable");

    expect(() => rethrowStreamRouteError(thrown, { route: "POST /chat" })).toThrow(
      ServiceUnavailableException,
    );
  });

  it("preserves the credit ledger's 402 so the client can tell 'top up' from 'we broke'", () => {
    const thrown = new InsufficientAiCreditsException({ message: "out of credits" });

    try {
      rethrowStreamRouteError(thrown, { route: "POST /chat" });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientAiCreditsException);
      expect((error as InsufficientAiCreditsException).getStatus()).toBe(402);
    }
  });

  it("preserves a 403 raised before the stream started", () => {
    expect(() =>
      rethrowStreamRouteError(new ForbiddenException("disabled"), { route: "POST /chat" }),
    ).toThrow(ForbiddenException);
  });

  it("wraps an unexpected fault in a 500 without leaking its message", () => {
    try {
      rethrowStreamRouteError(new Error("connection string leaked here"), {
        route: "POST /chat",
      });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect((error as Error).message).toBe("Internal server error");
    }
  });
});

/**
 * PRD-C154's citation-integrity clause.
 *
 * The encoder walked the list shortest-first and returned `null` the moment
 * nothing fit inside the 4 KB header budget, so ONE verbose source was enough to
 * strip every citation off a grounded answer — silently, with no log line and no
 * signal on the wire. The reader then saw a confident, apparently unsourced
 * answer, which is exactly the failure citation integrity exists to prevent.
 * Loss is now bounded (string fields are capped so one source cannot evict the
 * rest) and REPORTED (the shortfall is returned, published on a companion header
 * and warned about).
 */
describe("encodeStreamSources — a citation list never disappears silently", () => {
  it("still reports nothing for an empty list", () => {
    expect(encodeStreamSources([])).toBeNull();
  });

  it("reports a complete list as complete", () => {
    const sources = [{ articleId: 1, title: "Getting Started" }];

    const result = encodeStreamSources(sources);

    expect(result).not.toBeNull();
    expect(result?.dropped).toBe(0);
    expect(result?.included).toBe(1);
    expect(JSON.parse(decodeURIComponent(result?.encoded ?? ""))).toEqual(sources);
  });

  it("publishes a single oversized source instead of abandoning the header", () => {
    const result = encodeStreamSources([
      { articleId: 1, title: "y".repeat(20_000), snippet: "z".repeat(20_000) },
    ]);

    expect(result).not.toBeNull();
    expect(result?.included).toBe(1);
    expect(result?.dropped).toBe(0);
    const [only] = JSON.parse(decodeURIComponent(result?.encoded ?? "")) as Array<{
      articleId: number;
      title: string;
    }>;
    expect(only?.articleId).toBe(1);
    expect(only?.title.length).toBeLessThanOrEqual(160);
    expect(Buffer.byteLength(result?.encoded ?? "", "utf8")).toBeLessThanOrEqual(4_096);
  });

  it("counts what it had to drop rather than dropping it quietly", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      articleId: i,
      title: `Source ${i} `.repeat(20),
    }));

    const result = encodeStreamSources(many);

    expect(result).not.toBeNull();
    expect(result?.dropped).toBeGreaterThan(0);
    expect((result?.included ?? 0) + (result?.dropped ?? 0)).toBe(60);
    expect(Buffer.byteLength(result?.encoded ?? "", "utf8")).toBeLessThanOrEqual(4_096);
  });

  it("names the companion header off the sources header", () => {
    expect(sourcesTruncatedHeaderName("x-kb-sources")).toBe("x-kb-sources-truncated");
    expect(sourcesTruncatedHeaderName("x-ai-sources")).toBe("x-ai-sources-truncated");
  });
});
