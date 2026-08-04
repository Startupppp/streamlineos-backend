import { UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { decodeJwt } from "jose";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { PORTAL_AUDIENCE } from "../portal-auth/portal-claims";

jest.mock("jose", () => ({
  ...jest.requireActual("jose"),
  decodeJwt: jest.fn(),
  jwtVerify: jest.fn(),
}));

describe("JwtAuthGuard portal audience rejection", () => {
  it("rejects portal JWT before hitting internal APIs", async () => {
    (decodeJwt as jest.Mock).mockReturnValue({ aud: PORTAL_AUDIENCE, sub: "portal-member-1" });

    const guard = new JwtAuthGuard(
      new Reflector(),
      {} as never,
      null,
      { isAccountActive: jest.fn(), resolve: jest.fn() } as never,
    );

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
  });
});
