import { structuredNestLogger } from "./nest-logger.adapter";
import { runWithObservabilityContext } from "./observability-context";

type Line = Record<string, unknown>;

function capture(): { lines: Line[]; restore: () => void } {
  const lines: Line[] = [];
  const out = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(JSON.parse(String(chunk)) as Line);
    return true;
  });
  const err = jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(JSON.parse(String(chunk)) as Line);
    return true;
  });
  return { lines, restore: () => [out, err].forEach((s) => s.mockRestore()) };
}

describe("structuredNestLogger", () => {
  let captured: ReturnType<typeof capture>;

  beforeEach(() => {
    captured = capture();
  });
  afterEach(() => captured.restore());

  it("emits framework output as structured JSON rather than plain text", () => {
    structuredNestLogger.log("Nest application successfully started");
    expect(captured.lines[0]).toMatchObject({
      level: "info",
      message: "Nest application successfully started",
    });
  });

  it("keeps the emitting class as context so a line says where it came from", () => {
    structuredNestLogger.log("Mapped {/health, GET} route", "RouterExplorer");
    expect(captured.lines[0].meta).toMatchObject({ context: "RouterExplorer" });
  });

  it("maps each framework level onto the structured levels", () => {
    structuredNestLogger.warn("deprecated");
    structuredNestLogger.error("failed");
    structuredNestLogger.debug("detail");
    structuredNestLogger.verbose("noise");

    expect(captured.lines.map((line) => line.level)).toEqual([
      "warn",
      "error",
      "debug",
      "debug",
    ]);
  });

  it("captures the stack the framework passes alongside an error", () => {
    structuredNestLogger.error("boom", "Error: boom\n  at somewhere", "AppService");
    expect(captured.lines[0].meta).toMatchObject({
      context: "AppService",
      stack: "Error: boom\n  at somewhere",
    });
  });

  it("files a two-argument error's stack as a stack, not as the emitting class", () => {
    structuredNestLogger.error("boom", "Error: boom\n    at somewhere\n    at elsewhere");
    const meta = captured.lines[0].meta as Record<string, unknown>;
    expect(meta.stack).toContain("at somewhere");
    expect(meta.context).toBeUndefined();
  });

  it("still reads a two-argument single-line trailing value as the emitting class", () => {
    structuredNestLogger.error("boom", "PayrollService");
    expect(captured.lines[0].meta).toMatchObject({ context: "PayrollService" });
  });

  it("carries the ambient correlation identity, like every other log line", async () => {
    await runWithObservabilityContext({ correlationId: "c-1", orgId: "org-1" }, async () =>
      structuredNestLogger.log("something happened", "AppService"),
    );
    expect(captured.lines[0]).toMatchObject({ correlationId: "c-1", orgId: "org-1" });
  });

  it("redacts a credential the framework was handed", () => {
    structuredNestLogger.error("auth failed", { password: "hunter2" });
    expect(JSON.stringify(captured.lines[0])).not.toContain("hunter2");
  });

  it("renders a non-string message without collapsing it to [object Object]", () => {
    structuredNestLogger.log({ event: "started", port: 3000 });
    expect(captured.lines[0].message).not.toContain("[object Object]");
    expect(JSON.stringify(captured.lines[0])).toContain("3000");
  });
});
