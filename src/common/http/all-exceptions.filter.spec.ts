import { ArgumentsHost, BadRequestException, HttpException, NotFoundException } from "@nestjs/common";
import { ZodError, z } from "zod";
import { AllExceptionsFilter } from "./all-exceptions.filter";

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

  it("maps a string HttpException to { error }", () => {
    const { host, json, status } = hostWith();
    filter.catch(new NotFoundException("Deal not found"), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: "Deal not found" });
  });

  it("preserves structured HttpException bodies", () => {
    const { host, json, status } = hostWith();
    filter.catch(new HttpException({ error: "Forbidden", code: "RBAC_DENIED" }, 403), host);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: "Forbidden", code: "RBAC_DENIED" });
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
    expect(json.mock.calls[0][0].error).toMatch(/^Validation failed:/);
  });

  it("maps unknown errors to a 500 generic message", () => {
    const { host, json, status } = hostWith();
    filter.catch(new Error("boom"), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "An unexpected error occurred" });
  });

  it("passes BadRequestException message through", () => {
    const { host, json, status } = hostWith();
    filter.catch(new BadRequestException("Validation failed: a: Required"), host);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "Validation failed: a: Required" });
  });
});
