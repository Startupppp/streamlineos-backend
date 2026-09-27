import { Reflector } from "@nestjs/core";
import type { ArgumentsHost, CallHandler, ExecutionContext } from "@nestjs/common";
import { ZodError } from "zod";
import { ZodValidationInterceptor } from "../../../common/validation/zod-validation.interceptor";
import {
  VALIDATION_SCHEMAS,
  type ValidationSchemas,
} from "../../../common/validation/validate.decorator";
import { AllExceptionsFilter } from "../../../common/http/all-exceptions.filter";
import { ProjectsTicketsController } from "./projects-tickets.controller";

interface CapturedResponse {
  status?: number;
  body?: unknown;
}

function makeResponse(captured: CapturedResponse) {
  return {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    getHeader() {
      return undefined;
    },
    headersSent: false,
  };
}

function makeHost(captured: CapturedResponse): ArgumentsHost {
  const res = makeResponse(captured);
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ method: "POST", url: "/build/1/tickets", headers: {} }),
    }),
    getType: () => "http",
  };
  return host as unknown as ArgumentsHost;
}

function schemasFor(method: "createTicket" | "updateTicket"): ValidationSchemas {
  const reflector = new Reflector();
  const handler = ProjectsTicketsController.prototype[method];
  const schemas = reflector.get<ValidationSchemas | undefined>(VALIDATION_SCHEMAS, handler);
  if (!schemas?.body) throw new Error(`${method} declares no body schema`);
  return schemas;
}

function runInterceptor(
  schemas: ValidationSchemas,
  body: unknown,
  params: Record<string, string> = { projectId: "1" },
) {
  const reflector = new Reflector();
  jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(schemas);
  const interceptor = new ZodValidationInterceptor(reflector);
  const req: { body: unknown; params: Record<string, string>; query: unknown } = {
    body,
    params,
    query: {},
  };
  const context = {
    getHandler: () => () => undefined,
    getClass: () => ProjectsTicketsController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  const handled = { handled: false };
  const next: CallHandler = {
    handle: () => {
      handled.handled = true;
      return { subscribe: () => undefined } as never;
    },
  };
  interceptor.intercept(context, next);
  return { req, handled: handled.handled };
}

describe("an invalid ticket type is rejected as 400 by the route's own schema and the filter that catches it", () => {
  const VALID_BODY = {
    createTicket: { title: "A ticket", type: "TASK" },
    updateTicket: { title: "A ticket", type: "TASK", version: 1 },
  } as const;
  const PARAMS = {
    createTicket: { projectId: "1" },
    updateTicket: { projectId: "1", ticketId: "2" },
  } as const;

  it.each(["createTicket", "updateTicket"] as const)(
    "%s throws a ZodError for type 'SUBTASK' rather than passing it to the service",
    (method) => {
      const schemas = schemasFor(method);
      expect(() =>
        runInterceptor(schemas, { ...VALID_BODY[method], type: "SUBTASK" }, PARAMS[method]),
      ).toThrow(ZodError);
    },
  );

  it.each(["createTicket", "updateTicket"] as const)(
    "%s admits a valid type, so the rejection above is the schema discriminating and not the seam refusing everything",
    (method) => {
      const schemas = schemasFor(method);
      const { handled } = runInterceptor(schemas, VALID_BODY[method], PARAMS[method]);
      expect(handled).toBe(true);
    },
  );

  it("rejects every type outside the four the database enum declares, and admits all four", () => {
    const schemas = schemasFor("createTicket");
    for (const type of ["EPIC", "STORY", "TASK", "BUG"]) {
      expect(() => runInterceptor(schemas, { title: "A ticket", type })).not.toThrow();
    }
    for (const type of ["SUBTASK", "task", "CHORE", ""]) {
      expect(() => runInterceptor(schemas, { title: "A ticket", type })).toThrow(ZodError);
    }
  });

  it("maps the thrown ZodError to 400 VALIDATION_FAILED, never a 500", () => {
    const schemas = schemasFor("createTicket");
    let thrown: unknown;
    try {
      runInterceptor(schemas, { ...VALID_BODY.createTicket, type: "SUBTASK" });
    } catch (error) {
      thrown = error;
    }
    const captured: CapturedResponse = {};
    new AllExceptionsFilter().catch(thrown, makeHost(captured));

    expect(captured.status).toBe(400);
    expect(captured.status).not.toBe(500);
    expect(captured.body).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("names the offending field in the 400 details, so the client learns which value was refused", () => {
    const schemas = schemasFor("createTicket");
    let thrown: unknown;
    try {
      runInterceptor(schemas, { ...VALID_BODY.createTicket, type: "SUBTASK" });
    } catch (error) {
      thrown = error;
    }
    const captured: CapturedResponse = {};
    new AllExceptionsFilter().catch(thrown, makeHost(captured));

    const details = (captured.body as { details?: { path?: string }[] }).details;
    expect(details?.some((d) => d.path === "type")).toBe(true);
  });
});
