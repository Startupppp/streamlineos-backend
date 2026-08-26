import { z } from "zod";
import { Reflector } from "@nestjs/core";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { ZodValidationInterceptor } from "./zod-validation.interceptor";
import { queryBoolean } from "./query-boolean";

const schema = z
  .object({
    includeCompleted: queryBoolean.default(false),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

/**
 * An Express 5 request, in the one respect that matters here.
 *
 * `query` is a getter that re-parses the URL on every access rather than a
 * stored object, so anything written into the object it returns is written into
 * a value nothing will read again.
 */
function requestLike(raw: Record<string, string>): { query: Record<string, unknown> } {
  const req = {};
  Object.defineProperty(req, "query", {
    configurable: true,
    enumerable: true,
    get: () => ({ ...raw }),
  });
  return req as { query: Record<string, unknown> };
}

function contextFor(req: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe("query validation reaches the handler", () => {
  const next = { handle: () => ({}) } as unknown as CallHandler;

  function run(raw: Record<string, string>) {
    const reflector = new Reflector();
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue({ query: schema });
    const req = requestLike(raw);
    new ZodValidationInterceptor(reflector).intercept(contextFor(req), next);
    return req.query;
  }

  /**
   * The defect. Assigning into `req.query` mutates a throwaway object, so the
   * handler read the raw strings back and every coercion was inert.
   */
  it("hands the handler a number, not the string the URL carried", () => {
    expect(run({ limit: "2" }).limit).toBe(2);
  });

  it("applies the default when the caller omitted it", () => {
    expect(run({}).limit).toBe(25);
  });

  /** `"false"` is a non-empty string, and every non-empty string is truthy. */
  it("turns an explicit false into a real false", () => {
    expect(run({ includeCompleted: "false" }).includeCompleted).toBe(false);
  });

  it("still lets a real true through", () => {
    expect(run({ includeCompleted: "true" }).includeCompleted).toBe(true);
  });

  it("rejects what the schema rejects", () => {
    expect(() => run({ limit: "nope" })).toThrow();
  });
});
