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
  } as Partial<ExecutionContext> as ExecutionContext;
}

describe("JwtAuthGuard", () => {
  process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
  const reflector = { getAllAndOverride: jest.fn() } as unknown as jest.Mocked<Reflector>;
  const mockDb = {
    select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ catch: jest.fn() }) }) }),
    query: { users: { findFirst: jest.fn() }, organizationMembers: { findFirst: jest.fn() }, organizations: { findFirst: jest.fn() } },
  };
  const guard = new JwtAuthGuard(reflector, mockDb as unknown as import("../../db/drizzle.module").Db, null);

  beforeEach(() => reflector.getAllAndOverride.mockReturnValue(false));

  it("rejects a missing token with 401", async () => {
    await expect(guard.canActivate(ctxWith({}))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a malformed token with 401", async () => {
    await expect(
      guard.canActivate(ctxWith({ authorization: "Bearer not.a.jwt" })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("accepts a valid token and attaches req.user", async () => {
    const token = await signToken({ sub: "user_42", orgId: "org_9", sessionId: "sess_1" });
    const ctx = ctxWith({ authorization: `Bearer ${token}` });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = ctx.switchToHttp().getRequest<{ user: { userId: string } }>();
    expect(req.user.userId).toBe("user_42");
  });

  it("allows @Public routes without a token", async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
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

  it("rejects a token with missing sessionId", async () => {
    const { SignJWT } = await import("jose");
    const secret = process.env.BACKEND_JWT_SECRET ?? "x".repeat(44);
    const token = await new SignJWT({ sub: "u", orgId: "o", sessionId: "" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(secret));
    await expect(
      guard.canActivate(ctxWith({ authorization: `Bearer ${token}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a token with an empty-string orgId for a non-platform-admin", async () => {
    const { SignJWT } = await import("jose");
    const secret = process.env.BACKEND_JWT_SECRET ?? "x".repeat(44);
    const token = await new SignJWT({ sub: "u", orgId: "", sessionId: "sess_1", isPlatformAdmin: false })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(secret));
    await expect(
      guard.canActivate(ctxWith({ authorization: `Bearer ${token}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("accepts a platform-admin token with no orgId", async () => {
    const token = await signToken({ isPlatformAdmin: true, orgId: null, sessionId: "sess_admin" });
    const ctx = ctxWith({ authorization: `Bearer ${token}` });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = ctx.switchToHttp().getRequest<{ user: { isPlatformAdmin: boolean; orgId: string } }>();
    expect(req.user.isPlatformAdmin).toBe(true);
    expect(req.user.orgId).toBe("");
  });
});
