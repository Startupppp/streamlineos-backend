import { makeAuthContextFactory } from "../../../test/helpers/module-guard-context";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { decodeJwt } from "jose";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { JwtKeyringService } from "./jwt-keyring.service";
import { PORTAL_AUDIENCE } from "../portal-auth/portal-claims";

jest.mock("jose", () => ({
  ...jest.requireActual("jose"),
  decodeJwt: jest.fn(),
  jwtVerify: jest.fn(),
}));

function makeKeyring(overrides: Partial<JwtKeyringService> = {}): JwtKeyringService {
  return {
    isReady: jest.fn().mockReturnValue(true),
    verifyToken: jest.fn().mockResolvedValue(null),
    signToken: jest.fn(),
    getJwks: jest.fn(),
    onModuleInit: jest.fn(),
    ...overrides,
  } as unknown as JwtKeyringService;
}

function makeRevocationDb(): never {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ isRevoked: false }]),
        }),
      }),
    }),
  } as never;
}

function makeGuard(keyring: JwtKeyringService): JwtAuthGuard {
  return new JwtAuthGuard(
    new Reflector(),
    makeRevocationDb(),
    null,
    { isAccountActive: jest.fn(), resolve: jest.fn() } as never,
    keyring,
    makeAuthContextFactory(),
  );
}

describe("JwtAuthGuard portal audience rejection", () => {
  it("rejects portal JWT before hitting the keyring", async () => {
    (decodeJwt as jest.Mock).mockReturnValue({ aud: PORTAL_AUDIENCE, sub: "portal-member-1" });
    const keyring = makeKeyring();
    const guard = makeGuard(keyring);

    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: "Bearer portal-token" },
          method: "GET",
          path: "/build/projects",
        }),
      }),
    };

    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(keyring.verifyToken).not.toHaveBeenCalled();
  });
});

describe("JwtAuthGuard asymmetric JWT path", () => {
  beforeEach(() => {
    (decodeJwt as jest.Mock).mockReturnValue({ aud: "streamlineos-api", sub: "user-1" });
  });

  it("succeeds when keyring verifyToken returns valid claims", async () => {
    const keyring = makeKeyring({
      verifyToken: jest.fn().mockResolvedValue({
        sub: "user-1",
        orgId: "org-1",
        sessionId: "sess-1",
      }),
    });
    const guard = makeGuard(keyring);

    const membershipState = {
      isAccountActive: jest.fn().mockResolvedValue(true),
      resolve: jest.fn().mockResolvedValue({
        active: true,
        membershipId: "mem-1",
        role: "MEMBER",
        isOwner: false,
      }),
    };
    (guard as unknown as { membership: typeof membershipState }).membership = membershipState;

    const req = {
      headers: { authorization: "Bearer valid-asymmetric-token" },
      method: "GET",
      path: "/me",
      user: undefined as unknown,
    };

    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req }),
    };

    const result = await guard.canActivate(context as never);
    expect(result).toBe(true);
    expect((req.user as { userId?: string })?.userId).toBe("user-1");
  });

  it("falls through to PAT check when keyring returns null, then rejects with 401", async () => {
    const keyring = makeKeyring({ verifyToken: jest.fn().mockResolvedValue(null) });
    const guard = makeGuard(keyring);
    jest.spyOn(guard as unknown as { tryPatAuth(t: string): Promise<null> }, "tryPatAuth").mockResolvedValue(null);

    const req = {
      headers: { authorization: "Bearer unknown-token" },
      method: "GET",
      path: "/me",
    };

    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req }),
    };

    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a request with no Authorization header", async () => {
    const keyring = makeKeyring();
    const guard = makeGuard(keyring);

    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({ headers: {}, method: "GET", path: "/me" }) }),
    };

    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("passes Public routes without touching the keyring", async () => {
    const keyring = makeKeyring();
    const reflector = new Reflector();
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValueOnce(true);
    const guard = new JwtAuthGuard(
      reflector,
      {} as never,
      null,
      { isAccountActive: jest.fn(), resolve: jest.fn() } as never,
      keyring,
      makeAuthContextFactory(),
    );

    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({ headers: {}, method: "GET", path: "/public" }) }),
    };

    const result = await guard.canActivate(context as never);
    expect(result).toBe(true);
    expect(keyring.verifyToken).not.toHaveBeenCalled();
  });
});

describe("JwtAuthGuard employee removal — HTTP deny surface", () => {
  beforeEach(() => {
    (decodeJwt as jest.Mock).mockReturnValue({ aud: "streamlineos-api", sub: "user-removed" });
  });

  it("throws 403 ORG_MEMBERSHIP_INACTIVE when membership.resolve returns active false", async () => {
    const keyring = makeKeyring({
      verifyToken: jest.fn().mockResolvedValue({
        sub: "user-removed",
        orgId: "org-1",
        sessionId: "sess-removed",
      }),
    });
    const guard = makeGuard(keyring);

    const membershipState = {
      isAccountActive: jest.fn().mockResolvedValue(true),
      resolve: jest.fn().mockResolvedValue({
        active: false,
        membershipId: null,
        role: "",
        isOwner: false,
      }),
    };
    (guard as unknown as { membership: typeof membershipState }).membership = membershipState;

    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: "Bearer valid-but-removed-token" },
          method: "GET",
          path: "/build/projects",
        }),
      }),
    };

    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const err = await guard.canActivate(context as never).catch((e: unknown) => e);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: "ORG_MEMBERSHIP_INACTIVE",
    });
  });

  it("consults membership.resolve on every request — no cached allow decision survives removal", async () => {
    const keyring = makeKeyring({
      verifyToken: jest.fn().mockResolvedValue({
        sub: "user-toggled",
        orgId: "org-1",
        sessionId: "sess-toggled",
      }),
    });
    const guard = makeGuard(keyring);

    const resolveResults = [
      { active: true, membershipId: 42, role: "MEMBER", isOwner: false },
      { active: false, membershipId: null, role: "", isOwner: false },
    ];
    let resolveCallCount = 0;
    const membershipState = {
      isAccountActive: jest.fn().mockResolvedValue(true),
      resolve: jest.fn().mockImplementation(async () => resolveResults[resolveCallCount++]),
    };
    (guard as unknown as { membership: typeof membershipState }).membership = membershipState;

    const makeContext = () => ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: "Bearer valid-session-token" },
          method: "GET",
          path: "/me",
        }),
      }),
    });

    const firstResult = await guard.canActivate(makeContext() as never);
    expect(firstResult).toBe(true);

    await expect(guard.canActivate(makeContext() as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(membershipState.resolve).toHaveBeenCalledTimes(2);
  });
});
