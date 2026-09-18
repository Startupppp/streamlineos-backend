import { correlationIdMiddleware } from "./correlation-id.middleware";
import { getObservabilityContext } from "../observability/observability-context";
import {
  resetSpanExporter,
  setSpanExporter,
  type FinishedSpan,
} from "../observability/tracing";

type Req = {
  headers: Record<string, string | undefined>;
  method: string;
  path: string;
  ip?: string;
};

type StampedReq = Req & { correlationId?: string; requestId?: string };

/** The response double, which the span-ending tests drive directly. */
type ResDouble = {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  on: (event: string, listener: () => void) => void;
  emit: (event: string) => void;
};

function run(
  headers: Record<string, string | undefined> = {},
  extras: { ip?: string } = {},
): {
  seen: ReturnType<typeof getObservabilityContext>;
  responseHeader: string | undefined;
  headersSet: Record<string, string>;
  res: ResDouble;
  req: StampedReq;
} {
  const req = {
    headers,
    method: "GET",
    path: "/crm/parties",
    ...(extras.ip !== undefined ? { ip: extras.ip } : {}),
  } as Req;
  let responseHeader: string | undefined;
  const headersSet: Record<string, string> = {};
  // A real express response emits `finish`/`close` and carries a status; the
  // middleware ends the request's span on those, so the double has to have them.
  const listeners: Record<string, (() => void)[]> = {};
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string) => {
      headersSet[name.toLowerCase()] = value;
      if (name.toLowerCase() === "x-correlation-id") responseHeader = value;
    },
    on: (event: string, listener: () => void) => {
      (listeners[event] ??= []).push(listener);
    },
    emit: (event: string) => (listeners[event] ?? []).forEach((listener) => listener()),
  };
  let seen: ReturnType<typeof getObservabilityContext>;

  correlationIdMiddleware(req as never, res as never, () => {
    seen = getObservabilityContext();
  });

  return { seen, responseHeader, headersSet, res, req: req as StampedReq };
}

describe("correlationIdMiddleware", () => {
  it("generates a correlation id when the caller supplies none", () => {
    const { seen } = run();
    expect(seen?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("records the method and path so a log line identifies the request", () => {
    const { seen } = run();
    expect(seen).toMatchObject({ method: "GET", route: "/crm/parties" });
  });

  it("carries Express-resolved req.ip into the ambient context for audit writers", () => {
    const { seen } = run({}, { ip: "203.0.113.9" });
    expect(seen?.clientIp).toBe("203.0.113.9");
  });

  it("carries the User-Agent header into the ambient context", () => {
    const { seen } = run({ "user-agent": "StreamlineTest/1.0" });
    expect(seen?.userAgent).toBe("StreamlineTest/1.0");
  });

  it("does not invent a client IP when Express has none", () => {
    const { seen } = run();
    expect(seen?.clientIp).toBeUndefined();
  });

  it("returns the correlation id to the caller so they can quote it in a support request", () => {
    const { seen, responseHeader } = run();
    expect(responseHeader).toBe(seen?.correlationId);
  });

  it("reuses a caller-supplied correlation id so a trace spans services", () => {
    const { seen } = run({ "x-correlation-id": "abc-123" });
    expect(seen?.correlationId).toBe("abc-123");
  });

  it("accepts x-request-id as an alternative header", () => {
    const { seen } = run({ "x-request-id": "req-9" });
    expect(seen?.correlationId).toBe("req-9");
  });

  it("strips characters that would let a caller forge log structure", () => {
    const { seen } = run({ "x-correlation-id": 'a"b\n{"level":"error"}' });
    expect(seen?.correlationId).toBe("ab");
  });

  it("caps an oversized caller value rather than logging it in full", () => {
    const { seen } = run({ "x-correlation-id": "x".repeat(500) });
    expect(seen?.correlationId).toHaveLength(64);
  });

  it("generates an id when the caller value is entirely unusable", () => {
    const { seen } = run({ "x-correlation-id": "!!!!" });
    expect(seen?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("leaves no context behind once the request completes", () => {
    run();
    expect(getObservabilityContext()).toBeUndefined();
  });

  it("stamps the request so code holding only `req` sees the same id", () => {
    const { seen, req } = run();
    expect(req.correlationId).toBe(seen?.correlationId);
    expect(req.requestId).toBe(seen?.correlationId);
  });
});

describe("request tracing", () => {
  afterEach(() => resetSpanExporter());

  function collect(): FinishedSpan[] {
    const spans: FinishedSpan[] = [];
    setSpanExporter({ export: (span) => spans.push(span) });
    return spans;
  }

  it("echoes a traceparent so a caller can stitch the two halves together", () => {
    const { headersSet } = run({});
    expect(headersSet["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  /**
   * A request arriving from another service continues that service's trace
   * rather than starting an unrelated one.
   */
  it("joins an inbound trace", () => {
    const { headersSet } = run({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    });
    expect(headersSet["traceparent"]).toContain("4bf92f3577b34da6a3ce929d0e0e4736");
    // A new span id, not the caller's: this is a different span in their trace.
    expect(headersSet["traceparent"]).not.toContain("00f067aa0ba902b7");
  });

  it("starts its own trace when the caller offers a malformed one", () => {
    const { headersSet } = run({ traceparent: "not-a-traceparent" });
    expect(headersSet["traceparent"]).toMatch(/^00-[0-9a-f]{32}-/);
  });

  it("records the span when the response finishes", () => {
    const spans = collect();
    const { res } = run({});
    expect(spans).toHaveLength(0); // nothing yet: the request is still open
    res.emit("finish");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ name: "GET /crm/parties", status: "ok" });
  });

  it("marks a server error as one", () => {
    const spans = collect();
    const { res } = run({});
    res.statusCode = 503;
    res.emit("finish");
    expect(spans[0]).toMatchObject({ status: "error" });
  });

  it("records a request the client abandoned", () => {
    const spans = collect();
    const { res } = run({});
    res.emit("close");
    expect(spans).toHaveLength(1);
  });

  it("records the span once even though express emits both events", () => {
    const spans = collect();
    const { res } = run({});
    res.emit("finish");
    res.emit("close");
    expect(spans).toHaveLength(1);
  });

  it("carries the correlation id onto the span", () => {
    // So a span and a log line about the same request can be put side by side.
    const spans = collect();
    const { res, responseHeader } = run({});
    res.emit("finish");
    expect(spans[0]!.attributes["correlation.id"]).toBe(responseHeader);
  });
});
