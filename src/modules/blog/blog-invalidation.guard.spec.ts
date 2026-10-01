import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { BlogInvalidationSignatureGuard } from "./blog-invalidation.guard";
import type { BlogInvalidationService } from "./blog-invalidation.service";

function context(headers: Record<string, string | string[]>, rawBody: string): ExecutionContext {
  const request = { headers, rawBody: Buffer.from(rawBody) };
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe("BlogInvalidationSignatureGuard", () => {
  const verify = jest.fn();
  const guard = new BlogInvalidationSignatureGuard({ verify } as unknown as BlogInvalidationService);

  beforeEach(() => verify.mockReset());

  it("hands the service the exact raw body and the three signature headers", () => {
    const ctx = context(
      { "x-blog-event-id": "e", "x-blog-timestamp": "1", "x-blog-signature": "v1=abc" },
      '{"eventId":"e"}',
    );
    expect(guard.canActivate(ctx)).toBe(true);
    expect(verify).toHaveBeenCalledWith({ eventId: "e", timestamp: "1", signature: "v1=abc" }, '{"eventId":"e"}');
  });

  it("takes the first value when a header is repeated", () => {
    guard.canActivate(context({ "x-blog-event-id": ["first", "second"] }, ""));
    expect(verify.mock.calls[0]?.[0]).toMatchObject({ eventId: "first" });
  });

  // The guard exists so an unsigned caller is refused before any pipe parses or validates the
  // body: it must propagate the refusal rather than fall through to validation.
  it("propagates the service's refusal", () => {
    verify.mockImplementation(() => {
      throw new UnauthorizedException("Unauthorized");
    });
    expect(() => guard.canActivate(context({}, ""))).toThrow(UnauthorizedException);
  });
});
