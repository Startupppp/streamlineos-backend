import { runWithObservabilityContext, enrichObservabilityContext } from "./observability-context";
import { logger } from "../logger/logger.service";

type LogLine = Record<string, unknown>;

function captureWrites(): { lines: LogLine[]; restore: () => void } {
  const lines: LogLine[] = [];
  const outSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(JSON.parse(String(chunk)) as LogLine);
    return true;
  });
  const errSpy = jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(JSON.parse(String(chunk)) as LogLine);
    return true;
  });
  return { lines, restore: () => [outSpy, errSpy].forEach((s) => s.mockRestore()) };
}

describe("log context completeness", () => {
  let capture: ReturnType<typeof captureWrites>;

  beforeEach(() => {
    capture = captureWrites();
  });
  afterEach(() => capture.restore());

  it("a log line emitted inside a request context carries all mandatory fields, asserted on the JSON output", () => {
    runWithObservabilityContext(
      {
        correlationId: "cid-completeness-test",
        cellId: "cell-fixture",
        release: "sha-abc123",
        method: "GET",
        route: "/api/test",
      },
      () => {
        enrichObservabilityContext({ orgId: "org-fixture", actorId: "usr-fixture" });
        logger.info("completeness probe");
      },
    );

    expect(capture.lines).toHaveLength(1);
    const line = capture.lines[0];

    expect(line).toHaveProperty("correlationId", "cid-completeness-test");
    expect(line).toHaveProperty("cellId", "cell-fixture");
    expect(line).toHaveProperty("release", "sha-abc123");
    expect(line).toHaveProperty("orgId", "org-fixture");
    expect(line).toHaveProperty("actorId", "usr-fixture");
    expect(line).toHaveProperty("method", "GET");
    expect(line).toHaveProperty("route", "/api/test");
    expect(typeof line["timestamp"]).toBe("string");
    expect(line["level"]).toBe("info");
  });

  it("all seven fields are absent when no context is active — proves the test would fail on a gap", () => {
    logger.info("no-context probe");
    expect(capture.lines).toHaveLength(1);
    const line = capture.lines[0];
    expect(line).not.toHaveProperty("correlationId");
    expect(line).not.toHaveProperty("cellId");
    expect(line).not.toHaveProperty("release");
    expect(line).not.toHaveProperty("orgId");
    expect(line).not.toHaveProperty("actorId");
    expect(line).not.toHaveProperty("method");
    expect(line).not.toHaveProperty("route");
  });

  it("redactor strips secrets from metadata even inside a full context", () => {
    runWithObservabilityContext(
      { correlationId: "cid-redact", cellId: "cell-a", release: "sha-1", method: "POST", route: "/auth/login" },
      () => {
        enrichObservabilityContext({ orgId: "org-2", actorId: "usr-2" });
        logger.info("login attempt", { username: "alice", password: "s3cr3t", token: "bearer-xyz" });
      },
    );

    const meta = capture.lines[0]?.["meta"] as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(meta["username"]).toBe("alice");
    expect(meta["password"]).toBe("[redacted]");
    expect(meta["token"]).toBe("[redacted]");

    expect(capture.lines[0]).toHaveProperty("correlationId", "cid-redact");
    expect(capture.lines[0]).toHaveProperty("release", "sha-1");
  });

  it("release field persists on every log line within the same context", () => {
    runWithObservabilityContext(
      { correlationId: "cid-multi", cellId: "cell-b", release: "sha-deploy-42", method: "POST", route: "/api/data" },
      () => {
        enrichObservabilityContext({ orgId: "org-3", actorId: "usr-3" });
        logger.info("first");
        logger.info("second");
        logger.info("third");
      },
    );

    expect(capture.lines).toHaveLength(3);
    for (const line of capture.lines) {
      expect(line).toHaveProperty("release", "sha-deploy-42");
      expect(line).toHaveProperty("cellId", "cell-b");
      expect(line).toHaveProperty("correlationId", "cid-multi");
    }
  });
});
