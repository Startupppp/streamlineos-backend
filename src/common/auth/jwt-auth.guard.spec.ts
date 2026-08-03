import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtAuthGuard } from "./jwt-auth.guard";
import {
  INTERNAL_TOKEN_AUDIENCE,
  INTERNAL_TOKEN_ISSUER,
} from "./backend-claims";
import type { MembershipStateService } from "./membership-state.service";
import { signToken } from "../../../test/helpers/sign-token";

function ctxWith(headers: Record<string, string>): ExecutionContext {
  const req: { headers: Record<string, string>; user?: unknown } = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as Partial<ExecutionContext> as ExecutionContext;
}

async function signRaw(
  payload: Record<string, unknown>,
  options: { alg?: string; audience?: string; issuer?: string } = {},
): Promise<string> {
  const { SignJWT } = await import("jose");
  const secret = process.env.BACKEND_JWT_SECRET ?? "x".repeat(44);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: options.alg ?? "HS256" })
    .setIssuer(options.issuer ?? INTERNAL_TOKEN_ISSUER)
    .setAudience(options.audience ?? INTERNAL_TOKEN_AUDIENCE)
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(secret));
}

describe("JwtAuthGuard", () => {
  process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
  const reflector = { getAllAndOverride: jest.fn() } as unknown as jest.Mocked<Reflector>;
  function emptySelectChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit"]) {
      chain[method] = jest.fn().mockReturnValue(chain);
    }
    chain.then = (onFulfilled: (rows: unknown[]) => unknown) => Promise.resolve([]).then(onFulfilled);
    return chain;
  }
  const mockDb = {
    select: jest.fn(() => emptySelectChain()),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ catch: jest.fn() }) }) }),
    query: { users: { findFirst: jest.fn() }, organizationMembers: { findFirst: jest.fn() }, organizations: { findFirst: jest.fn() } },
  };
  const membership = {
    resolve: jest.fn().mockResolvedValue({ active: true, isOwner: false, role: "MEMBER" }),
    isAccountActive: jest.fn().mockResolvedValue(true),
  } as unknown as MembershipStateService;
  const guard = new JwtAuthGuard(
    reflector,
    mockDb as unknown as import("../../db/drizzle.module").Db,
    null,
    membership,
  );

  beforeEach(() => {
    reflector.getAllAndOverride.mockReturnValue(false);
    mockDb.query.users.findFirst.mockResolvedValue(undefined);
  });

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

  it("resolves role and ownership from the membership row, not from the token", async () => {
    (membership.resolve as jest.Mock).mockResolvedValueOnce({
      active: true,
      isOwner: true,
      role: "OWNER",
    });
    const token = await signToken({ sub: "user_42", orgId: "org_9", isOrgOwner: false, role: "MEMBER" });
    const ctx = ctxWith({ authorization: `Bearer ${token}` });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = ctx
      .switchToHttp()
      .getRequest<{ user: { isOrgOwner: boolean; role: string; tokenScopes: string[] | null } }>();
    expect(req.user.isOrgOwner).toBe(true);
    expect(req.user.role).toBe("OWNER");
    expect(req.user.tokenScopes).toBeNull();
  });

  it("rejects a token whose membership is no longer active", async () => {
    (membership.resolve as jest.Mock).mockResolvedValueOnce({
      active: false,
      isOwner: false,
      role: "MEMBER",
    });
    const token = await signToken({ sub: "user_42", orgId: "org_9" });
    await expect(
      guard.canActivate(ctxWith({ authorization: `Bearer ${token}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("allows @Public routes without a token", async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    await expect(guard.canActivate(ctxWith({}))).resolves.toBe(true);
  });

  it("rejects a token signed with a non-HS256 algorithm", async () => {
    const token = await signRaw({ sub: "u", orgId: "o", sessionId: "sess_1" }, { alg: "HS512" });
    await expect(
      guard.canActivate(ctxWith({ authorization: `Bearer ${token}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a token minted for another audience", async () => {
    const token = await signRaw(
      { sub: "u", orgId: "o", sessionId: "sess_1" },
      { audience: "client-portal" },
    );
    await expect(
      guard.canActivate(ctxWith({ authorization: `Bearer ${token}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a token from an unrecognised issuer", async () => {
    const token = await signRaw(
      { sub: "u", orgId: "o", sessionId: "sess_1" },
      { issuer: "someone-else" },
    );
    await expect(
      guard.canActivate(ctxWith({ authorization: `Bearer ${token}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a token with missing sessionId", async () => {
    const token = await signRaw({ sub: "u", orgId: "o", sessionId: "" });
    await expect(
      guard.canActivate(ctxWith({ authorization: `Bearer ${token}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a token with an empty-string orgId for a non-platform-admin with 403", async () => {
    const token = await signRaw({ sub: "u", orgId: "", sessionId: "sess_1" });
    await expect(
      guard.canActivate(ctxWith({ authorization: `Bearer ${token}` })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
