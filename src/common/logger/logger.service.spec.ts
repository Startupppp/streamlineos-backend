import { runWithObservabilityContext } from "../observability/observability-context";
import { logger } from "./logger.service";

type Line = Record<string, unknown>;

function captureStdout(): { lines: Line[]; restore: () => void } {
  const lines: Line[] = [];
  const outSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(JSON.parse(String(chunk)) as Line);
    return true;
  });
  const errSpy = jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(JSON.parse(String(chunk)) as Line);
    return true;
  });
  return { lines, restore: () => [outSpy, errSpy].forEach((s) => s.mockRestore()) };
}

describe("logger", () => {
  let capture: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    capture = captureStdout();
  });
  afterEach(() => capture.restore());

  it("emits one parseable JSON record per call", () => {
    logger.info("hello");
    expect(capture.lines).toHaveLength(1);
    expect(capture.lines[0]).toMatchObject({ level: "info", message: "hello" });
    expect(typeof capture.lines[0].timestamp).toBe("string");
  });

  it("omits context fields when there is no ambient context", () => {
    logger.info("hello");
    expect(capture.lines[0]).not.toHaveProperty("correlationId");
    expect(capture.lines[0]).not.toHaveProperty("orgId");
  });

  it("stamps every record with the ambient correlation, organisation and actor", async () => {
    await runWithObservabilityContext(
      { correlationId: "c-1", orgId: "org-1", actorId: "user-1" },
      async () => logger.warn("careful"),
    );

    expect(capture.lines[0]).toMatchObject({
      level: "warn",
      message: "careful",
      correlationId: "c-1",
      orgId: "org-1",
      actorId: "user-1",
    });
  });

  it("redacts credentials passed in metadata", () => {
    logger.error("failed", { orgId: "org-1", password: "hunter2" });
    expect(capture.lines[0].meta).toEqual({ orgId: "org-1", password: "[redacted]" });
  });

  it("summarises an Error in metadata instead of emitting an empty object", () => {
    logger.error("failed", { error: new Error("boom") });
    const meta = capture.lines[0].meta as { error: Record<string, unknown> };
    expect(meta.error).toMatchObject({ name: "Error", message: "boom" });
  });

  it("includes the cause chain so a driver error's root is visible", () => {
    const cause = new Error("ECONNREFUSED 127.0.0.1:5432");
    logger.error("query failed", { error: new Error("outer", { cause }) });
    const meta = capture.lines[0].meta as { error: Record<string, unknown> };
    expect(meta.error).toMatchObject({ name: "Error", message: "outer" });
    expect(meta.error.cause).toMatchObject({ name: "Error", message: "ECONNREFUSED 127.0.0.1:5432" });
  });

  it("writes warnings and errors to stderr and everything else to stdout", () => {
    capture.restore();
    const out = jest.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = jest.spyOn(process.stderr, "write").mockReturnValue(true);

    logger.info("a");
    logger.error("b");

    expect(out).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1);
    out.mockRestore();
    err.mockRestore();
  });
});
