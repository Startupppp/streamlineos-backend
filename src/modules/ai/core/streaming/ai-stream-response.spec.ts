import type { ServerResponse } from "http";
import {
  ForbiddenException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import {
  encodeStreamSourcesHeader,
  pipeAiTextStream,
  rethrowStreamRouteError,
  type PipeableAiTextStream,
} from "./ai-stream-response";

function makeResponse(): ServerResponse & { writableEnded: boolean; end: jest.Mock } {
  return {
    writableEnded: false,
    end: jest.fn(function (this: { writableEnded: boolean }) {
      this.writableEnded = true;
    }),
  } as unknown as ServerResponse & { writableEnded: boolean; end: jest.Mock };
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

  it("closes a response the failed pipe left open", async () => {
    const res = makeResponse();
    const stream: PipeableAiTextStream = {
      pipeTextStreamToResponse: jest.fn().mockRejectedValue(new Error("upstream 503")),
    };

    await pipeAiTextStream(res, stream, { feature: "f", orgId: "org_1" });

    expect(res.end).toHaveBeenCalledTimes(1);
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

describe("encodeStreamSourcesHeader — citations survive a truncated stream", () => {
  it("returns null for an empty source list", () => {
    expect(encodeStreamSourcesHeader([])).toBeNull();
  });

  it("round-trips through decodeURIComponent + JSON.parse", () => {
    const sources = [{ articleId: 10, title: "Getting Started, v2", slug: "getting-started" }];

    const encoded = encodeStreamSourcesHeader(sources);

    expect(encoded).not.toBeNull();
    expect(JSON.parse(decodeURIComponent(encoded as string))).toEqual(sources);
  });

  it("drops trailing sources rather than emitting a header the server will reject", () => {
    const big = Array.from({ length: 40 }, (_, i) => ({
      articleId: i,
      title: "x".repeat(400),
    }));

    const encoded = encodeStreamSourcesHeader(big);

    expect(encoded).not.toBeNull();
    expect(Buffer.byteLength(encoded as string, "utf8")).toBeLessThanOrEqual(4_096);
    expect((JSON.parse(decodeURIComponent(encoded as string)) as unknown[]).length).toBeLessThan(40);
  });
});
