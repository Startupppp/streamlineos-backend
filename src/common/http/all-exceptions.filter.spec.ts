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
});
