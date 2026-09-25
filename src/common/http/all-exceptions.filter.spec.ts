import { ArgumentsHost, BadRequestException, HttpException, NotFoundException } from "@nestjs/common";
import { ZodError, z } from "zod";
import { AllExceptionsFilter } from "./all-exceptions.filter";
import {
  resetErrorReporter,
  setErrorReporter,
  type ErrorReport,
} from "../observability/error-reporter";
import { runWithObservabilityContext } from "../observability/observability-context";

function hostWith(
  options: { correlationId?: string } = {},
): { host: ArgumentsHost; json: jest.Mock; status: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn((): { json: jest.Mock } => ({ json }));
  const host: ArgumentsHost = {
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method: "GET", url: "/x", correlationId: options.correlationId }),
      getNext: () => undefined,
    }),
    switchToRpc: () => ({} as ReturnType<ArgumentsHost["switchToRpc"]>),
    switchToWs: () => ({} as ReturnType<ArgumentsHost["switchToWs"]>),
    getType: () => "http",
  } as ArgumentsHost;
  return { host, json, status };
}

/** The same host, addressed at a chosen route. */
function hostFor(url: string): ArgumentsHost {
  const json = jest.fn();
  const status = jest.fn((): { json: jest.Mock } => ({ json }));
  return {
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method: "GET", url }),
      getNext: () => undefined,
    }),
    switchToRpc: () => ({} as ReturnType<ArgumentsHost["switchToRpc"]>),
    switchToWs: () => ({} as ReturnType<ArgumentsHost["switchToWs"]>),
    getType: () => "http",
  } as ArgumentsHost;
}

describe("AllExceptionsFilter", () => {
  const filter = new AllExceptionsFilter();

  it("maps a string HttpException to the shared public envelope", () => {
    const { host, json, status } = hostWith();
    filter.catch(new NotFoundException("Deal not found"), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      code: "NOT_FOUND",
      message: "Deal not found",
    });
  });

  it("preserves structured HttpException bodies", () => {
    const { host, json, status } = hostWith();
    filter.catch(new HttpException({ error: "Forbidden", code: "RBAC_DENIED" }, 403), host);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      code: "RBAC_DENIED",
      message: "Forbidden",
    });
  });

  it("maps a raw ZodError to a 400 with detail", () => {
    const { host, json, status } = hostWith();
    const zerr = (() => {
      try {
        z.object({ a: z.string() }).parse({});
        return new ZodError([]);
      } catch (e) {
        return e as ZodError;
      }
    })();
    filter.catch(zerr, host);
    expect(status).toHaveBeenCalledWith(400);
    expect(json.mock.calls[0][0]).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Validation failed.",
      details: [{ path: "a", message: expect.any(String) }],
    });
  });

  it("maps unknown errors to a 500 generic message", () => {
    const { host, json, status } = hostWith();
    filter.catch(new Error("boom"), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    });
  });

  it("maps a body-parser rejection to its real status instead of a 500", () => {
    const { host, json, status } = hostWith();
    filter.catch(
      Object.assign(new Error("request entity too large"), { type: "entity.too.large" }),
      host,
    );
    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({
      code: "PAYLOAD_TOO_LARGE",
      message: "The request payload is too large.",
    });
  });

  it("leaves an unrelated error carrying a type field on the 500 path", () => {
    const { host, json, status } = hostWith();
    filter.catch(Object.assign(new Error("boom"), { type: "something.else" }), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    });
  });

  it("passes BadRequestException message through", () => {
    const { host, json, status } = hostWith();
    filter.catch(new BadRequestException("Validation failed: a: Required"), host);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      code: "BAD_REQUEST",
      message: "Validation failed: a: Required",
    });
  });

  it("does not expose unstructured provider fields from an HttpException body", () => {
    const { host, json } = hostWith();
    filter.catch(
      new HttpException(
        {
          message: "Delivery failed.",
          providerResponse: "smtp credential rejected",
        },
        502,
      ),
      host,
    );

    expect(json).toHaveBeenCalledWith({
      code: "HTTP_502",
      message: "Delivery failed.",
    });
  });

  describe("correlation id in error envelope", () => {
    it("includes correlationId in the body when the middleware set it on the request", () => {
      const { host, json } = hostWith({ correlationId: "req-abc-123" });
      filter.catch(new NotFoundException("Not found"), host);
      expect(json.mock.calls[0]?.[0]).toMatchObject({ correlationId: "req-abc-123" });
    });

    it("omits correlationId entirely when absent from the request", () => {
      const { host, json } = hostWith();
      filter.catch(new NotFoundException("Not found"), host);
      expect(json.mock.calls[0]?.[0]).not.toHaveProperty("correlationId");
    });

    it("includes correlationId on a ZodError 400 so the caller can quote the body", () => {
      const { host, json } = hostWith({ correlationId: "zod-cid-456" });
      const zerr = (() => {
        try {
          z.object({ a: z.string() }).parse({});
          return new ZodError([]);
        } catch (e) {
          return e as ZodError;
        }
      })();
      filter.catch(zerr, host);
      expect(json.mock.calls[0]?.[0]).toMatchObject({
        code: "VALIDATION_FAILED",
        correlationId: "zod-cid-456",
      });
    });

    it("includes correlationId on an unhandled 500", () => {
      const { host, json } = hostWith({ correlationId: "500-cid-789" });
      filter.catch(new Error("boom"), host);
      expect(json.mock.calls[0]?.[0]).toMatchObject({
        code: "INTERNAL_ERROR",
        correlationId: "500-cid-789",
      });
    });
  });

  describe("operational reporting", () => {
    let reports: ErrorReport[];

    beforeEach(() => {
      reports = [];
      setErrorReporter({ report: (r) => reports.push(r) });
    });
    afterEach(() => resetErrorReporter());

    it("reports an unhandled error so a human is told, not just a log file", () => {
      const { host } = hostWith();
      const boom = new Error("boom");

      filter.catch(boom, host);

      expect(reports).toHaveLength(1);
      expect(reports[0].error).toBe(boom);
      expect(reports[0].extra).toMatchObject({ method: "GET", url: "/x" });
    });

    it("attaches the correlation identity so the report joins the request's logs", async () => {
      const { host } = hostWith();

      await runWithObservabilityContext(
        { correlationId: "c-1", orgId: "org-1" },
        async () => filter.catch(new Error("boom"), host),
      );

      expect(reports[0].context).toMatchObject({ correlationId: "c-1", orgId: "org-1" });
    });

    it("does not report an expected client error", () => {
      const { host } = hostWith();
      filter.catch(new NotFoundException("Deal not found"), host);
      expect(reports).toHaveLength(0);
    });

    it("keeps driver diagnostics that quote the offending row out of the log", () => {
      const { host } = hostWith();
      const stderr = jest.spyOn(process.stderr, "write").mockReturnValue(true);

      // A real 23505 populates `detail` far more often than `query`.
      const dbError = Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        detail: "Key (email)=(ada@example.com) already exists.",
        hint: "Try a different address for ada@example.com",
        query: "insert into parties (email) values ('ada@example.com')",
        table_name: "parties",
        column_name: "email",
      });
      filter.catch(dbError, host);

      const written = stderr.mock.calls.map((call) => String(call[0])).join("");
      stderr.mockRestore();

      expect(written).not.toContain("ada@example.com");
      expect(written).toContain("[redacted]");
      // The non-sensitive diagnostics survive, or the redaction is useless.
      expect(written).toContain("parties");
      expect(written).toContain("email");
      expect(written).toContain("duplicate key value violates unique constraint");
    });

    it("keeps a public share token out of the error report, because the path segment is the whole bearer credential", () => {
      const token = "Ab3dEf7hIj0lMn4pQr8tUv2x";

      filter.catch(new Error("boom"), hostFor(`/public/wiki/${token}`));

      expect(reports).toHaveLength(1);
      expect(JSON.stringify(reports[0].extra)).not.toContain(token);
    });

    it("keeps a public share token out of the error report on the /v1 alias, which a client that pinned the version prefix still sends", () => {
      const token = "Qw1eRt2yUi3oPa4sDf5gHj6k";

      filter.catch(new Error("boom"), hostFor(`/v1/public/wiki/${token}`));

      expect(reports).toHaveLength(1);
      expect(JSON.stringify(reports[0].extra)).not.toContain(token);
    });

    it("keeps a public share token out of the log line for a server-side HttpException", () => {
      const token = "Zz9yXw8vUt7sRq6pOn5mLk4j";
      const stderr = jest.spyOn(process.stderr, "write").mockReturnValue(true);

      filter.catch(
        new HttpException("upstream failed", 502),
        hostFor(`/public/wiki/${token}`),
      );

      const written = stderr.mock.calls.map((call) => String(call[0])).join("");
      stderr.mockRestore();

      expect(written).not.toContain(token);
      expect(written).toContain("/public/wiki");
    });

    it("still reports the unredacted path of an ordinary route, or the redaction is indiscriminate", () => {
      filter.catch(new Error("boom"), hostFor("/kb/pages/4321"));

      expect(reports).toHaveLength(1);
      expect(reports[0].extra).toMatchObject({ url: "/kb/pages/4321" });
    });
  });
});

describe("health probes and error noise", () => {
  /**
   * Probes are polled continuously by the platform, so a database blip becomes
   * thousands of identical reports and buries everything else. They still log,
   * and the probe still fails — this only keeps the tracker readable.
   */
  it("does not report a failing health probe to the tracker", () => {
    const reported: unknown[] = [];
    setErrorReporter({ report: (r) => reported.push(r) });

    for (const url of ["/health", "/health/ready", "/health/db", "/health/db?verbose=1"]) {
      const filter = new AllExceptionsFilter();
      filter.catch(new Error("database unreachable"), hostFor(url));
    }

    expect(reported).toHaveLength(0);
    resetErrorReporter();
  });

  it("still reports an ordinary route failing", () => {
    const reported: unknown[] = [];
    setErrorReporter({ report: (r) => reported.push(r) });

    const filter = new AllExceptionsFilter();
    filter.catch(new Error("boom"), hostFor("/crm/deals"));

    expect(reported).toHaveLength(1);
    resetErrorReporter();
  });

  it("is not fooled by a route that merely starts with the word", () => {
    const reported: unknown[] = [];
    setErrorReporter({ report: (r) => reported.push(r) });

    const filter = new AllExceptionsFilter();
    filter.catch(new Error("boom"), hostFor("/healthcare/claims"));

    expect(reported).toHaveLength(1);
    resetErrorReporter();
  });
});

describe("AllExceptionsFilter once a streaming response has begun", () => {
  function streamingHost(state: { headersSent: boolean; writableEnded: boolean }): {
    host: ArgumentsHost;
    status: jest.Mock;
    end: jest.Mock;
  } {
    const json = jest.fn();
    const status = jest.fn((): { json: jest.Mock } => ({ json }));
    const end = jest.fn();
    const host = {
      getArgs: () => [],
      getArgByIndex: () => undefined,
      switchToHttp: () => ({
        getResponse: () => ({ status, end, ...state }),
        getRequest: () => ({ method: "POST", url: "/ai/chat" }),
        getNext: () => undefined,
      }),
      switchToRpc: () => ({} as ReturnType<ArgumentsHost["switchToRpc"]>),
      switchToWs: () => ({} as ReturnType<ArgumentsHost["switchToWs"]>),
      getType: () => "http",
    } as ArgumentsHost;
    return { host, status, end };
  }

  it("does not set a status after headers are sent, because doing so throws ERR_HTTP_HEADERS_SENT inside the filter where nothing can catch it", () => {
    const { host, status } = streamingHost({ headersSent: true, writableEnded: false });

    new AllExceptionsFilter().catch(new Error("provider died mid-stream"), host);

    expect(status).not.toHaveBeenCalled();
  });

  it("ends the half-written response so a failed stream does not hang the client open", () => {
    const { host, end } = streamingHost({ headersSent: true, writableEnded: false });

    new AllExceptionsFilter().catch(new Error("provider died mid-stream"), host);

    expect(end).toHaveBeenCalledTimes(1);
  });

  it("leaves an already-ended response alone rather than double-ending it", () => {
    const { host, status, end } = streamingHost({ headersSent: true, writableEnded: true });

    new AllExceptionsFilter().catch(new Error("provider died mid-stream"), host);

    expect(status).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });

  it("still writes a normal envelope when the stream has not started", () => {
    const { host, status, end } = streamingHost({ headersSent: false, writableEnded: false });

    new AllExceptionsFilter().catch(new NotFoundException("Deal not found"), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(end).not.toHaveBeenCalled();
  });
});

function hostCapturingHeaders(): {
  host: ArgumentsHost;
  json: jest.Mock;
  status: jest.Mock;
  setHeader: jest.Mock;
} {
  const json = jest.fn();
  const status = jest.fn((): { json: jest.Mock } => ({ json }));
  const setHeader = jest.fn();
  const host: ArgumentsHost = {
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToHttp: () => ({
      getResponse: () => ({ status, setHeader, headersSent: false }),
      getRequest: () => ({ method: "POST", url: "/x" }),
      getNext: () => undefined,
    }),
    switchToRpc: () => ({} as ReturnType<ArgumentsHost["switchToRpc"]>),
    switchToWs: () => ({} as ReturnType<ArgumentsHost["switchToWs"]>),
    getType: () => "http",
  } as ArgumentsHost;
  return { host, json, status, setHeader };
}

describe("AllExceptionsFilter — Retry-After on 429", () => {
  const filter = new AllExceptionsFilter();

  it("projects retryAfterSecs onto the Retry-After header, because a service throwing 429 has no Response to set it on", () => {
    const { host, status, setHeader } = hostCapturingHeaders();

    filter.catch(
      new HttpException({ message: "Queue is full", retryAfterSecs: 30 }, 429),
      host,
    );

    expect(status).toHaveBeenCalledWith(429);
    expect(setHeader).toHaveBeenCalledWith("Retry-After", "30");
  });

  it("rounds a fractional delay up, because Retry-After is an integer count of seconds and rounding down asks the caller back too early", () => {
    const { host, setHeader } = hostCapturingHeaders();

    filter.catch(
      new HttpException({ message: "Slow down", retryAfterSecs: 1.2 }, 429),
      host,
    );

    expect(setHeader).toHaveBeenCalledWith("Retry-After", "2");
  });

  it("sets no header on a 429 that carries no delay, so the caller is never handed a fabricated wait", () => {
    const { host, status, setHeader } = hostCapturingHeaders();

    filter.catch(new HttpException({ message: "Rate limited" }, 429), host);

    expect(status).toHaveBeenCalledWith(429);
    expect(setHeader).not.toHaveBeenCalled();
  });

  it("leaves a non-429 alone even when its body carries retryAfterSecs, because Retry-After on a 409 would tell the caller to blindly retry a conflict", () => {
    const { host, status, setHeader } = hostCapturingHeaders();

    filter.catch(
      new HttpException({ message: "Conflict", retryAfterSecs: 30 }, 409),
      host,
    );

    expect(status).toHaveBeenCalledWith(409);
    expect(setHeader).not.toHaveBeenCalled();
  });

  it("ignores a negative delay rather than emitting it, because a negative Retry-After is not a valid header value", () => {
    const { host, setHeader } = hostCapturingHeaders();

    filter.catch(
      new HttpException({ message: "Broken", retryAfterSecs: -5 }, 429),
      host,
    );

    expect(setHeader).not.toHaveBeenCalled();
  });
});
