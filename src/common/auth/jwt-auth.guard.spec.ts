import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { signToken } from "../../../test/helpers/sign-token";

function ctxWith(headers: Record<string, string>): ExecutionContext {
  const req: { headers: Record<string, string>; user?: unknown } = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe("JwtAuthGuard", () => {
  process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
  const reflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;
  const guard = new JwtAuthGuard(reflector);

  beforeEach(() => (reflector.getAllAndOverride as jest.Mock).mockReturnValue(false));

  it("rejects a missing token with 401", async () => {
    await expect(guard.canActivate(ctxWith({}))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a malformed token with 401", async () => {
    await expect(
      guard.canActivate(ctxWith({ authorization: "Bearer not.a.jwt" })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("accepts a valid token and attaches req.user", async () => {
    const token = await signToken({ sub: "user_42", orgId: "org_9" });
    const ctx = ctxWith({ authorization: `Bearer ${token}` });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = (ctx as unknown as { switchToHttp: () => { getRequest: () => { user: { userId: string } } } })
      .switchToHttp().getRequest();
    expect(req.user.userId).toBe("user_42");
  });

  it("allows @Public routes without a token", async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(true);
    await expect(guard.canActivate(ctxWith({}))).resolves.toBe(true);
  });

  it("rejects a token signed with a non-HS256 algorithm", async () => {
    const { SignJWT } = await import("jose");
    const secret = process.env.BACKEND_JWT_SECRET ?? "x".repeat(44);
    const token = await new SignJWT({ sub: "u", orgId: "o" })
      .setProtectedHeader({ alg: "HS512" })
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(secret));
    await expect(
      guard.canActivate(ctxWith({ authorization: `Bearer ${token}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
