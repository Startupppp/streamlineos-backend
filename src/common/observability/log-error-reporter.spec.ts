import { LogErrorReporter } from "./log-error-reporter";
import type { ErrorReport } from "./error-reporter";

function capture(report: ErrorReport): { line: string; record: Record<string, unknown> } {
  const written: string[] = [];
  const spy = jest
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    });
  try {
    new LogErrorReporter().report(report);
  } finally {
    spy.mockRestore();
  }
  const line = written.join("");
  return { line, record: JSON.parse(line) as Record<string, unknown> };
}

function reportOf(error: unknown, extra?: Record<string, unknown>): ErrorReport {
  return {
    error,
    context: {
      correlationId: "corr-1",
      orgId: "org-1",
      actorId: "user-1",
      method: "POST",
      route: "/notifications",
    },
    ...(extra !== undefined ? { extra } : {}),
  };
}

describe("LogErrorReporter", () => {
  it("writes one JSON line carrying organisation, actor, route and correlation id", () => {
    const { line, record } = capture(reportOf(new Error("boom")));

    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);
    expect(record).toMatchObject({
      level: "error",
      message: "ERROR_REPORT",
      correlationId: "corr-1",
      orgId: "org-1",
      actorId: "user-1",
      method: "POST",
      route: "/notifications",
    });
  });

  it("carries a release marker and a fingerprint that groups repeat occurrences", () => {
    const previous = process.env["APP_RELEASE"];
    process.env["APP_RELEASE"] = "sha-abc123";
    try {
      const frame = "DealsService.find (/app/src/modules/crm/deals.service.ts:44:11)";
      const occurrence = (id: string): Error => {
        const error = new Error(`row ${id} is not visible`);
        error.stack = [`Error: row ${id} is not visible`, `    at ${frame}`].join("\n");
        return error;
      };

      const first = capture(reportOf(occurrence("8f14e45f-ceea-467a-9a3f-000000000000"))).record;
      const second = capture(reportOf(occurrence("1a2b3c4d-5e6f-4a7b-8c9d-111111111111"))).record;

      expect(first["release"]).toBe("sha-abc123");
      expect(first["fingerprint"]).toBe(second["fingerprint"]);
    } finally {
      if (previous === undefined) delete process.env["APP_RELEASE"];
      else process.env["APP_RELEASE"] = previous;
    }
  });

  it("reports an unset release as unknown rather than omitting the field", () => {
    const previous = process.env["APP_RELEASE"];
    delete process.env["APP_RELEASE"];
    try {
      expect(capture(reportOf(new Error("boom"))).record["release"]).toBe("unknown");
    } finally {
      if (previous !== undefined) process.env["APP_RELEASE"] = previous;
    }
  });

  it("redacts a credential passed as extra detail", () => {
    const { line, record } = capture(
      reportOf(new Error("boom"), {
        authorization: "Bearer sk-live-abc123",
        accessToken: "sk-live-abc123",
        orgSlug: "acme",
      }),
    );

    expect(line).not.toContain("sk-live-abc123");
    expect(record["extra"]).toEqual({
      authorization: "[redacted]",
      accessToken: "[redacted]",
      orgSlug: "acme",
    });
  });

  /**
   * The alert this feeds (`pnpm alert:tenant-ctx-errors`) matches
   * `level === "error"` AND the raw line containing "42501". The SQLSTATE is on
   * the driver error's `code`, never in its message, and Drizzle wraps it — so
   * before the code was lifted out this line matched nothing and the alert could
   * not fire on the incident it exists for.
   */
  it("emits the SQLSTATE for a missing tenant GUC so the alert predicate matches", () => {
    const driverError = Object.assign(new Error("permission denied for table notifications"), {
      code: "42501",
    });
    const wrapped = Object.assign(new Error("Failed query: insert into notifications"), {
      cause: driverError,
    });

    const { line, record } = capture(reportOf(wrapped));

    expect(line).toContain("42501");
    expect(record).toMatchObject({ level: "error", sqlstate: "42501", errorClass: "tenant-context" });
  });

  it("does not label an unrelated database error as tenant-context", () => {
    const conflict = Object.assign(new Error("duplicate key value"), { code: "23505" });

    const { record } = capture(reportOf(conflict));

    expect(record["sqlstate"]).toBe("23505");
    expect(record["errorClass"]).toBeUndefined();
  });

  it("truncates a looping cause chain instead of recursing until the stack gives out", () => {
    const root = new Error("root");
    let current = root;
    for (let i = 0; i < 10; i += 1) {
      current = Object.assign(new Error(`wrap-${i}`), { cause: current });
    }

    expect(() => capture(reportOf(current))).not.toThrow();
    const { line } = capture(reportOf(current));
    expect(line).toContain("[cause chain truncated]");
  });

  it("reports a thrown non-error without crashing", () => {
    const { record } = capture(reportOf("just a string"));
    expect(record["error"]).toBe("just a string");
  });
});
