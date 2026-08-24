import { ArgumentsHost, BadRequestException, HttpException, NotFoundException } from "@nestjs/common";
import { ZodError, z } from "zod";
import { AllExceptionsFilter } from "./all-exceptions.filter";
import {
  resetErrorReporter,
  setErrorReporter,
  type ErrorReport,
} from "../observability/error-reporter";
import { runWithObservabilityContext } from "../observability/observability-context";

function hostWith(): { host: ArgumentsHost; json: jest.Mock; status: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn((): { json: jest.Mock } => ({ json }));
  const host: ArgumentsHost = {
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method: "GET", url: "/x" }),
      getNext: () => undefined,
    }),
    switchToRpc: () => ({} as ReturnType<ArgumentsHost["switchToRpc"]>),
    switchToWs: () => ({} as ReturnType<ArgumentsHost["switchToWs"]>),
    getType: () => "http",
  } as ArgumentsHost;
  return { host, json, status };
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
  });
});
