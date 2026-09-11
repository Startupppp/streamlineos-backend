import { logger } from "../logger/logger.service";
import { logSideEffectFailure } from "../logger/side-effect";
import { LogErrorReporter } from "./log-error-reporter";
import { LogSpanExporter } from "./log-span-exporter";
import { redact, scrubBindParameters, truncateForLog } from "./redact";

/**
 * Drizzle raises `DrizzleQueryError` with
 * `Failed query: <sql>\nparams: <bind values>`, so the values a failing statement
 * was about to write live in the message — not on a key any redactor could reach.
 * Every generic handler re-emits that message, which is what makes this a leak on
 * paths nobody wrote deliberately.
 */
const SALARY = "8250000";
const EMAIL = "ada@lovelace.example";
const DRIZZLE_MESSAGE =
  'Failed query: insert into "hr_compensation" ("email", "annual_ctc") values ($1, $2)\n' +
  `params: ${EMAIL},${SALARY}`;

function drizzleError(): Error {
  return Object.assign(new Error(DRIZZLE_MESSAGE), {
    query: 'insert into "hr_compensation" ("email", "annual_ctc") values ($1, $2)',
    params: [EMAIL, SALARY],
  });
}

function captureWrites(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const out = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  const err = jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => [out, err].forEach((spy) => spy.mockRestore()) };
}

describe("bite proof — the fixture really does carry the bind values", () => {
  it("Drizzle's message quotes both the email and the salary", () => {
    expect(DRIZZLE_MESSAGE).toContain(EMAIL);
    expect(DRIZZLE_MESSAGE).toContain(SALARY);
  });

  it("scrubBindParameters leaves an unrelated message that mentions parameters alone", () => {
    const unrelated = "Rejected 3 params: id, name, cursor";
    expect(scrubBindParameters(unrelated)).toBe(unrelated);
  });

  it("scrubBindParameters keeps the SQL shape, which is the diagnostic half", () => {
    const scrubbed = scrubBindParameters(DRIZZLE_MESSAGE);
    expect(scrubbed).toContain("hr_compensation");
    expect(scrubbed).not.toContain(EMAIL);
    expect(scrubbed).not.toContain(SALARY);
  });
});

describe("bind values never reach a log line", () => {
  let capture: ReturnType<typeof captureWrites>;
  beforeEach(() => {
    capture = captureWrites();
  });
  afterEach(() => capture.restore());

  it("not through the message, which is where a `logger.error(`… ${err.message}`)` puts them", () => {
    logger.error(`after-commit hook failed: ${DRIZZLE_MESSAGE}`);
    const joint = capture.lines.join("");
    expect(joint).not.toContain(EMAIL);
    expect(joint).not.toContain(SALARY);
    expect(joint).toContain("hr_compensation");
  });

  it("not through meta, which is where forEachOrg's per-organisation catch puts them", () => {
    logger.error("[outbox-retention] organization sweep failed", {
      orgId: "org-1",
      error: DRIZZLE_MESSAGE,
    });
    const joint = capture.lines.join("");
    expect(joint).not.toContain(EMAIL);
    expect(joint).not.toContain(SALARY);
    expect(joint).toContain("org-1");
  });

  it("not through an Error passed as meta", () => {
    logger.warn("write failed", { cause: drizzleError() });
    const joint = capture.lines.join("");
    expect(joint).not.toContain(EMAIL);
    expect(joint).not.toContain(SALARY);
  });

  it("not through logSideEffectFailure's cause chain", () => {
    logSideEffectFailure("notification delivery", { orgId: "org-1" })(
      new Error("wrapper", { cause: drizzleError() }),
    );
    const joint = capture.lines.join("");
    expect(joint).not.toContain(EMAIL);
    expect(joint).not.toContain(SALARY);
  });

  it("not through the error reporter, whose describe() does not go via redact()", () => {
    new LogErrorReporter().report({ error: drizzleError(), context: undefined });
    const joint = capture.lines.join("");
    expect(joint).not.toContain(EMAIL);
    expect(joint).not.toContain(SALARY);
    expect(joint).toContain("ERROR_REPORT");
  });

  it("not through a span attribute", () => {
    new LogSpanExporter().export({
      traceId: "0".repeat(31) + "1",
      spanId: "0".repeat(15) + "1",
      sampled: true,
      name: "db.query.execute",
      parentSpanId: null,
      startedAt: Date.now(),
      durationMs: 4,
      status: "error",
      attributes: { seam: "db.query.execute", "db.error": DRIZZLE_MESSAGE },
    });
    const joint = capture.lines.join("");
    expect(joint).not.toContain(EMAIL);
    expect(joint).not.toContain(SALARY);
    expect(joint).toContain("db.query.execute");
  });
});

describe("the `params` property itself is withheld", () => {
  it("redact() does not surface a params key", () => {
    const out = redact({ table: "hr_compensation", params: [EMAIL, SALARY] }) as Record<
      string,
      unknown
    >;
    expect(out["params"]).toBe("[redacted]");
    expect(out["table"]).toBe("hr_compensation");
  });

  it("truncateForLog scrubs before it truncates — the other order would keep the first 1000 chars of the bind list", () => {
    const longParams = `Failed query: select 1\nparams: ${EMAIL},${"9".repeat(2_000)}`;
    const out = truncateForLog(longParams);
    expect(out).not.toContain(EMAIL);
    expect(out).toContain("params: [redacted]");
  });
});
