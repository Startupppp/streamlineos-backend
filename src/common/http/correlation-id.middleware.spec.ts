import { correlationIdMiddleware } from "./correlation-id.middleware";
import { getObservabilityContext } from "../observability/observability-context";

type Req = { headers: Record<string, string | undefined>; method: string; path: string };

type StampedReq = Req & { correlationId?: string; requestId?: string };

function run(headers: Record<string, string | undefined> = {}): {
  seen: ReturnType<typeof getObservabilityContext>;
  responseHeader: string | undefined;
  req: StampedReq;
} {
  const req = { headers, method: "GET", path: "/crm/parties" } as Req;
  let responseHeader: string | undefined;
  const res = {
    setHeader: (name: string, value: string) => {
      if (name.toLowerCase() === "x-correlation-id") responseHeader = value;
    },
  };
  let seen: ReturnType<typeof getObservabilityContext>;

  correlationIdMiddleware(req as never, res as never, () => {
    seen = getObservabilityContext();
  });

  return { seen, responseHeader, req: req as StampedReq };
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
