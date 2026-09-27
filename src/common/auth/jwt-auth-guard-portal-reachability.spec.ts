import { makeAuthContextFactory } from "../../../test/helpers/module-guard-context";
import { Controller, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { decodeJwt, jwtVerify } from "jose";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { JwtKeyringService } from "./jwt-keyring.service";
import { PORTAL_AUDIENCE } from "../portal-auth/portal-claims";
import { PortalRoute } from "../portal-auth/portal-route.decorator";
import { PortalClientController } from "../../modules/portal/client/portal-client.controller";
import { PortalJwtAuthGuard } from "../portal-auth/portal-jwt-auth.guard";
import type { Db } from "../../db/drizzle.module";

jest.mock("jose", () => ({
  ...jest.requireActual("jose"),
  decodeJwt: jest.fn(),
  jwtVerify: jest.fn(),
}));

function makeKeyring(): JwtKeyringService {
  return {
    isReady: jest.fn().mockReturnValue(true),
    verifyToken: jest.fn().mockResolvedValue(null),
    signToken: jest.fn(),
    getJwks: jest.fn(),
    onModuleInit: jest.fn(),
  } as unknown as JwtKeyringService;
}

function makeGuard(): JwtAuthGuard {
  return new JwtAuthGuard(
    new Reflector(),
    {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ isRevoked: false }]),
          }),
        }),
      }),
    } as never,
    null,
    { isAccountActive: jest.fn(), resolve: jest.fn() } as never,
    makeKeyring(),
    makeAuthContextFactory(),
  );
}

@Controller("portal/v1/fixture")
@PortalRoute()
class PortalFixtureController {}

@Controller("build/projects")
class FirstPartyFixtureController {}

function contextFor(target: unknown) {
  return {
    getType: () => "http",
    getHandler: () => ({}),
    getClass: () => target,
    switchToHttp: () => ({
      getRequest: () => ({
        headers: { authorization: "Bearer portal-token" },
        method: "GET",
        path: "/portal/v1/projects",
      }),
    }),
  } as never;
}

beforeEach(() => {
  (decodeJwt as jest.Mock).mockReturnValue({
    aud: PORTAL_AUDIENCE,
    sub: "portal-member-1",
  });
});

describe("the global JwtAuthGuard runs before the portal's own guard, so it must not reject the portal's own routes", () => {
  it("defers a portal-marked route to PortalJwtAuthGuard instead of 401ing the whole client portal", async () => {
    await expect(makeGuard().canActivate(contextFor(PortalFixtureController))).resolves.toBe(true);
  });

  it("still rejects a portal token aimed at a first-party route, which is what the audience check is for", async () => {
    await expect(
      makeGuard().canActivate(contextFor(FirstPartyFixtureController)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe("the marker is on the controller that needs it, not only available to be used", () => {
  it("marks PortalClientController, whose every route is otherwise unreachable", async () => {
    await expect(makeGuard().canActivate(contextFor(PortalClientController))).resolves.toBe(true);
  });
});

describe("PortalJwtAuthGuard closes the hole that PortalRoute opens in JwtAuthGuard", () => {
  function makePortalGuard(): PortalJwtAuthGuard {
    process.env.PORTAL_JWT_SECRET = "x".repeat(44);
    const guard = new PortalJwtAuthGuard({} as unknown as Db);
    delete process.env.PORTAL_JWT_SECRET;
    return guard;
  }

  function noHeaderContext(): never {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers: {} }),
      }),
    } as never;
  }

  function backendTokenContext(): never {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: "Bearer backend-signed-token" },
        }),
      }),
    } as never;
  }

  it("rejects a backend-audience JWT aimed at a portal route — jwtVerify fails the audience check so the guard throws 401", async () => {
    (jwtVerify as jest.Mock).mockRejectedValue(new Error("JWTClaimValidationFailed"));
    const guard = makePortalGuard();
    await expect(guard.canActivate(backendTokenContext())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a portal route request with no Authorization header — unauthenticated access is still denied after JwtAuthGuard defers", async () => {
    const guard = makePortalGuard();
    await expect(guard.canActivate(noHeaderContext())).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
