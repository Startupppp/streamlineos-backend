import { logger } from "../logger/logger.service";
import { LogSpanExporter } from "./log-span-exporter";
import { LogErrorReporter } from "./log-error-reporter";
import { AllExceptionsFilter } from "../http/all-exceptions.filter";
import type { ArgumentsHost } from "@nestjs/common";
import { setErrorReporter, resetErrorReporter } from "./error-reporter";

const AUTH_TOKEN = "Bearer sk-live-realtoken987654";
const CARD_PAN = "4111-1111-1111-1111";
const NATIONAL_ID_SSN = "123-45-6789";
const BANK_ACCOUNT = "00-123456789012";
const EMAIL_PII = "user@example.com";
const PHONE_PII = "+91-9876543210";
const ADDRESS_PII = "123 Main Street, Delhi 110001";

type CapturedLines = Record<string, unknown>[];

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  const errSpy = jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => [spy, errSpy].forEach((s) => s.mockRestore()) };
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

function hostFor(url: string): ArgumentsHost {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
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

describe("Surface 1 — structured logger: PII in meta is redacted at emission", () => {
  let cap: ReturnType<typeof captureStdout>;
  beforeEach(() => { cap = captureStdout(); });
  afterEach(() => cap.restore());

  it("(bite proof) fixture contains auth token so this test would catch a leak", () => {
    const meta = { authorization: AUTH_TOKEN, orgId: "org-1" };
    expect(JSON.stringify(meta)).toContain(AUTH_TOKEN);
  });

  it("auth token under 'authorization' key is not in the emitted log line", () => {
    logger.error("auth check failed", { authorization: AUTH_TOKEN, orgId: "org-1" });
    const joint = cap.lines.join("");
    expect(joint).not.toContain(AUTH_TOKEN);
    expect(joint).toContain("[redacted]");
  });

  it("card PAN under 'cardNumber' key is not in the emitted log line", () => {
    logger.error("payment error", { cardNumber: CARD_PAN, amount: 100 });
    const joint = cap.lines.join("");
    expect(joint).not.toContain(CARD_PAN);
    expect(joint).toContain("[redacted]");
  });

  it("national ID under 'ssn' key is not in the emitted log line", () => {
    logger.info("profile lookup", { ssn: NATIONAL_ID_SSN, orgId: "org-1" });
    const joint = cap.lines.join("");
    expect(joint).not.toContain(NATIONAL_ID_SSN);
    expect(joint).toContain("[redacted]");
  });

  it("bank account number under 'accountNumber' key is not in the emitted log line", () => {
    logger.info("payroll run", { accountNumber: BANK_ACCOUNT, amount: 5000 });
    const joint = cap.lines.join("");
    expect(joint).not.toContain(BANK_ACCOUNT);
    expect(joint).toContain("[redacted]");
  });

  it("(FINDING — DECISION REQUIRED) email under 'email' key currently appears in log — not in SENSITIVE_EXACT list", () => {
    logger.info("invite sent", { email: EMAIL_PII, orgId: "org-1" });
    const joint = cap.lines.join("");
    expect(joint).toContain(EMAIL_PII);
  });

  it("(FINDING — DECISION REQUIRED) phone under 'phone' key currently appears in log — not in SENSITIVE_EXACT list", () => {
    logger.info("sms sent", { phone: PHONE_PII, orgId: "org-1" });
    const joint = cap.lines.join("");
    expect(joint).toContain(PHONE_PII);
  });
});

describe("Surface 2 — LogSpanExporter: span attributes with PII are redacted before emission", () => {
  it("(bite proof) fixture span attribute contains auth token so this test would catch an unredacted attribute", () => {
    const attrWithToken = { seam: "db.query.execute", token: AUTH_TOKEN };
    expect(JSON.stringify(attrWithToken)).toContain(AUTH_TOKEN);
  });

  it("span attribute named 'token' is not written to stdout in the SPAN line", () => {
    const written: string[] = [];
    const spy = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    try {
      const exporter = new LogSpanExporter();
      exporter.export({
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        parentSpanId: null,
        name: "db.query.execute",
        startedAt: Date.now() - 10,
        durationMs: 10,
        status: "ok",
        sampled: true,
        attributes: { seam: "db.query.execute", token: AUTH_TOKEN },
      });
    } finally {
      spy.mockRestore();
    }

    const joint = written.join("");
    expect(joint).toContain('"message":"SPAN"');
    expect(joint).not.toContain(AUTH_TOKEN);
    expect(joint).toContain("[redacted]");
  });

  it("span attribute named 'cardNumber' is not written to stdout", () => {
    const written: string[] = [];
    const spy = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    try {
      new LogSpanExporter().export({
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        parentSpanId: null,
        name: "payment.charge",
        startedAt: Date.now() - 20,
        durationMs: 20,
        status: "ok",
        sampled: true,
        attributes: { seam: "payment.charge", cardNumber: CARD_PAN },
      });
    } finally {
      spy.mockRestore();
    }

    const joint = written.join("");
    expect(joint).not.toContain(CARD_PAN);
    expect(joint).toContain("[redacted]");
  });

  it("non-sensitive span attributes like seam, latencyMs pass through unchanged", () => {
    const written: string[] = [];
    const spy = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    try {
      new LogSpanExporter().export({
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        parentSpanId: null,
        name: "db.query.execute",
        startedAt: Date.now() - 5,
        durationMs: 5,
        status: "ok",
        sampled: true,
        attributes: { seam: "db.query.execute", rowCount: 3, cached: false },
      });
    } finally {
      spy.mockRestore();
    }

    const joint = written.join("");
    const record = JSON.parse(joint) as Record<string, unknown>;
    expect(record["seam"]).toBe("db.query.execute");
    expect(record["rowCount"]).toBe(3);
    expect(record["cached"]).toBe(false);
  });
});

describe("Surface 3 — AllExceptionsFilter: unhandled exception log path does not leak provider PII", () => {
  const filter = new AllExceptionsFilter();

  beforeEach(() => setErrorReporter({ report: () => undefined }));
  afterEach(() => resetErrorReporter());

  it("(bite proof) provider error fixture contains PII that would be a leak if emitted", () => {
    const providerError = Object.assign(
      new Error(`Delivery failed for ${EMAIL_PII}: auth=${AUTH_TOKEN}`),
      { code: "23505", detail: `Key (email)=(${EMAIL_PII}) already exists.` },
    );
    expect(providerError.message).toContain(AUTH_TOKEN);
    expect(providerError.detail).toContain(EMAIL_PII);
  });

  it("driver detail quoting a PII value is not emitted when an unhandled error is logged", () => {
    const { lines, restore } = captureStderr();
    const dbError = Object.assign(
      new Error("duplicate key value violates unique constraint"),
      {
        code: "23505",
        detail: `Key (email)=(${EMAIL_PII}) already exists.`,
        hint: `Try a different address for ${EMAIL_PII}`,
        query: `insert into users (email) values ('${EMAIL_PII}')`,
        table_name: "users",
        column_name: "email",
      },
    );

    try {
      filter.catch(dbError, hostFor("/hr/employees"));
    } finally {
      restore();
    }

    const joint = lines.join("");
    expect(joint).not.toContain(EMAIL_PII);
    expect(joint).toContain("[redacted]");
    expect(joint).toContain("users");
    expect(joint).toContain("email");
  });

  it("response body for a 500 never contains PII regardless of what the error carries", () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host: ArgumentsHost = {
      getArgs: () => [],
      getArgByIndex: () => undefined,
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ method: "POST", url: "/payroll/runs" }),
        getNext: () => undefined,
      }),
      switchToRpc: () => ({} as ReturnType<ArgumentsHost["switchToRpc"]>),
      switchToWs: () => ({} as ReturnType<ArgumentsHost["switchToWs"]>),
      getType: () => "http",
    } as ArgumentsHost;

    const providerError = new Error(`Provider rejected: card ${CARD_PAN} declined`);

    const { restore } = captureStderr();
    try {
      filter.catch(providerError, host);
    } finally {
      restore();
    }

    const body = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain(CARD_PAN);
    expect(body["message"]).toBe("An unexpected error occurred");
  });
});

describe("Surface 4 — LogErrorReporter: extra detail with PII is redacted before emission", () => {
  function captureReport(error: unknown, extra?: Record<string, unknown>): string {
    const written: string[] = [];
    const spy = jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      new LogErrorReporter().report({
        error,
        context: {
          correlationId: "corr-pii-test",
          orgId: "org-pii-test",
          actorId: "user-pii-test",
          method: "POST",
          route: "/hr/employees",
        },
        ...(extra !== undefined ? { extra } : {}),
      });
    } finally {
      spy.mockRestore();
    }
    return written.join("");
  }

  it("(bite proof) fixture extra contains auth token so this test would catch an unredacted extra field", () => {
    const extra = { authorization: AUTH_TOKEN, module: "hr" };
    expect(JSON.stringify(extra)).toContain(AUTH_TOKEN);
  });

  it("auth token in extra is not present in the emitted ERROR_REPORT line", () => {
    const line = captureReport(new Error("provider call failed"), {
      authorization: AUTH_TOKEN,
      module: "mail",
    });
    expect(line).not.toContain(AUTH_TOKEN);
    expect(line).toContain("[redacted]");
    expect(line).toContain('"message":"ERROR_REPORT"');
  });

  it("card PAN in extra is not present in the emitted ERROR_REPORT line", () => {
    const line = captureReport(new Error("payment processor error"), {
      cardNumber: CARD_PAN,
      amount: 9900,
    });
    expect(line).not.toContain(CARD_PAN);
    expect(line).toContain("[redacted]");
  });

  it("national ID (ssn) in extra is not present in the emitted ERROR_REPORT line", () => {
    const line = captureReport(new Error("KYC check failed"), {
      ssn: NATIONAL_ID_SSN,
      userId: "user-123",
    });
    expect(line).not.toContain(NATIONAL_ID_SSN);
    expect(line).toContain("[redacted]");
  });

  it("bank account number in extra is not present in the emitted ERROR_REPORT line", () => {
    const line = captureReport(new Error("bank transfer failed"), {
      accountNumber: BANK_ACCOUNT,
      bankCode: "HDFC0001234",
    });
    expect(line).not.toContain(BANK_ACCOUNT);
    expect(line).toContain("[redacted]");
  });

  it("non-sensitive extra fields like orgId and module survive intact", () => {
    const line = captureReport(new Error("timeout"), { orgId: "org-1", module: "crm" });
    const record = JSON.parse(line) as Record<string, unknown>;
    const extra = record["extra"] as Record<string, unknown>;
    expect(extra["orgId"]).toBe("org-1");
    expect(extra["module"]).toBe("crm");
  });
});
