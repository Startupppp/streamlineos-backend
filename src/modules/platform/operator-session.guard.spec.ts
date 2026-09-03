import { BadRequestException, ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { OperatorSessionGuard } from "./operator-session.guard";
import type { PlatformOperatorAccessService } from "./platform-operator-access.service";

type MockOperatorService = {
  authorizeRequest: jest.Mock;
};

function makeService(opts: { throws?: Error } = {}): MockOperatorService {
  return {
    authorizeRequest: opts.throws
      ? jest.fn().mockRejectedValue(opts.throws)
      : jest.fn().mockResolvedValue(undefined),
  };
}

function makeReflector(scope: string | undefined): Reflector {
  return { getAllAndOverride: jest.fn().mockReturnValue(scope) } as unknown as Reflector;
}

function makeContext(opts: {
  userId?: string;
  orgId?: string;
  method?: string;
  principalKind?: "human-session" | "service-api-key";
  /** `undefined` keeps Express's normal `{ path }`; `omitRoute` removes the key entirely. */
  route?: unknown;
  omitRoute?: boolean;
}): ExecutionContext {
  const req = {
    user: opts.userId !== undefined
      ? {
          userId: opts.userId,
          orgId: "operator-home-org",
          role: "MEMBER",
          isOrgOwner: false,
          sessionId: "session-1",
          tokenScopes: null,
          principal: {
            kind: opts.principalKind ?? "human-session",
            membershipId: 1,
            isOrgOwner: false,
          },
        }
      : undefined,
    params: opts.orgId !== undefined ? { orgId: opts.orgId } : {},
    headers: {},
    method: opts.method ?? "GET",
    url: "/platform/admin/orgs/org-1/employees",
    ip: "10.0.0.1",
    ...(opts.omitRoute
      ? {}
      : {
          route:
            opts.route === undefined
              ? { path: "/platform/admin/orgs/:orgId/employees" }
              : opts.route,
        }),
  };
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("OperatorSessionGuard", () => {
  describe("no @RequireOperatorGrant — passthrough", () => {
    it("returns true when no scope metadata is present on the handler", async () => {
      const svc = makeService();
      const guard = new OperatorSessionGuard(makeReflector(undefined), svc as unknown as PlatformOperatorAccessService);
      const result = await guard.canActivate(makeContext({ userId: "op-alice", orgId: "org-1" }));
      expect(result).toBe(true);
      expect(svc.authorizeRequest).not.toHaveBeenCalled();
    });
  });

  describe("@RequireOperatorGrant present — grant checked", () => {
    it("(bite proof) throws ForbiddenException when no active grant exists — assertGrant rejects", async () => {
      const noGrant = new ForbiddenException("No active operator access grant");
      const svc = makeService({ throws: noGrant });
      const guard = new OperatorSessionGuard(
        makeReflector("read_customer_data"),
        svc as unknown as PlatformOperatorAccessService,
      );
      await expect(
        guard.canActivate(makeContext({ userId: "op-alice", orgId: "org-1" })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(svc.authorizeRequest).toHaveBeenCalledTimes(1);
    });

    it("returns true and calls assertAndLog when an active grant exists", async () => {
      const svc = makeService();
      const guard = new OperatorSessionGuard(
        makeReflector("read_customer_data"),
        svc as unknown as PlatformOperatorAccessService,
      );
      const result = await guard.canActivate(makeContext({ userId: "op-alice", orgId: "org-1" }));
      expect(result).toBe(true);
      expect(svc.authorizeRequest).toHaveBeenCalledWith(
        "op-alice",
        "org-1",
        "read_customer_data",
        expect.stringContaining("operator."),
        expect.anything(),
      );
    });

    it("(bite proof) throws UnauthorizedException when no JWT user is on the request", async () => {
      const svc = makeService();
      const guard = new OperatorSessionGuard(
        makeReflector("read_customer_data"),
        svc as unknown as PlatformOperatorAccessService,
      );
      await expect(
        guard.canActivate(makeContext({ orgId: "org-1" })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(svc.authorizeRequest).not.toHaveBeenCalled();
    });

    it("(bite proof) rejects a non-human principal even when it names an operator user", async () => {
      const svc = makeService();
      const guard = new OperatorSessionGuard(
        makeReflector("read_customer_data"),
        svc as unknown as PlatformOperatorAccessService,
      );
      await expect(
        guard.canActivate(makeContext({
          userId: "op-service",
          orgId: "org-1",
          principalKind: "service-api-key",
        })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(svc.authorizeRequest).not.toHaveBeenCalled();
    });

    it("(bite proof) throws BadRequestException when no :orgId param on the route", async () => {
      const svc = makeService();
      const guard = new OperatorSessionGuard(
        makeReflector("read_customer_data"),
        svc as unknown as PlatformOperatorAccessService,
      );
      await expect(
        guard.canActivate(makeContext({ userId: "op-alice" })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(svc.authorizeRequest).not.toHaveBeenCalled();
    });

    it("passes scope, operatorUserId and orgId to assertAndLog — cross-org isolation enforced by the service", async () => {
      const svc = makeService();
      const guard = new OperatorSessionGuard(
        makeReflector("read_payments"),
        svc as unknown as PlatformOperatorAccessService,
      );
      await guard.canActivate(makeContext({ userId: "op-charlie", orgId: "org-acme" }));
      const [userId, orgId, scope] = svc.authorizeRequest.mock.calls[0] as [string, string, string];
      expect(userId).toBe("op-charlie");
      expect(orgId).toBe("org-acme");
      expect(scope).toBe("read_payments");
    });

    it("action string encodes method and route so the audit log is human-readable", async () => {
      const svc = makeService();
      const guard = new OperatorSessionGuard(
        makeReflector("read_customer_data"),
        svc as unknown as PlatformOperatorAccessService,
      );
      await guard.canActivate(makeContext({ userId: "op-alice", orgId: "org-1", method: "POST" }));
      const [, , , action] = svc.authorizeRequest.mock.calls[0] as [string, string, string, string];
      expect(action).toContain("operator.");
      expect(action.toLowerCase()).toContain("post");
    });

    it("sets the request tenant to the granted target org before interceptors open the RLS transaction", async () => {
      const svc = makeService();
      const guard = new OperatorSessionGuard(
        makeReflector("read_customer_data"),
        svc as unknown as PlatformOperatorAccessService,
      );
      const context = makeContext({ userId: "op-alice", orgId: "customer-org" });

      await guard.canActivate(context);

      const request = context.switchToHttp().getRequest<{
        user: { orgId: string };
      }>();
      expect(request.user.orgId).toBe("customer-org");
      expect(svc.authorizeRequest).toHaveBeenCalledWith(
        "op-alice",
        "customer-org",
        "read_customer_data",
        expect.any(String),
        expect.anything(),
      );
    });
  });

  /*
   * The negative test for the one `as unknown as` this guard carries
   * (operator-session.guard.ts:46, ledgered `external`). Its invariant is a
   * DEGRADATION claim: `req.route` is attached by Express at dispatch time, is
   * absent from the Nest request type, and an absent one must fall back to
   * `req.url` rather than throw. The ledger proves the cast is declared and
   * cannot multiply; it does not prove the fallback. These do.
   *
   * Every shape below is one the cast's own type — `{ route?: { path?: string } }`
   * — asserts cannot happen, which is the point: the cast is a promise about a
   * property TypeScript is not checking, so the promise has to be checked here.
   * A guard that throws on a request Express shaped differently fails CLOSED on
   * an operator route, which reads as a revoked grant rather than as a bug.
   */
  describe("the `req.route` fallback the cast asserts", () => {
    const CONCRETE_URL = "/platform/admin/orgs/org-1/employees";

    async function actionFor(route: { route?: unknown; omitRoute?: boolean }): Promise<string> {
      const svc = makeService();
      const guard = new OperatorSessionGuard(
        makeReflector("read_customer_data"),
        svc as unknown as PlatformOperatorAccessService,
      );
      await expect(
        guard.canActivate(makeContext({ userId: "op-alice", orgId: "org-1", ...route })),
      ).resolves.toBe(true);
      const [, , , action] = svc.authorizeRequest.mock.calls[0] as [string, string, string, string];
      return action;
    }

    it("names the route TEMPLATE when Express attached one, so the fallback is distinguishable", async () => {
      // The control. Without it every assertion below could pass on a guard
      // that ignored `req.route` entirely and always used the URL.
      await expect(actionFor({})).resolves.toBe(
        "operator.get./platform/admin/orgs/:orgId/employees",
      );
    });

    it("degrades to req.url when the route key is absent altogether", async () => {
      await expect(actionFor({ omitRoute: true })).resolves.toBe(`operator.get.${CONCRETE_URL}`);
    });

    it("degrades to req.url when a route object carries no path", async () => {
      await expect(actionFor({ route: {} })).resolves.toBe(`operator.get.${CONCRETE_URL}`);
    });

    it.each([
      ["null", null],
      ["a string", "GET /platform/admin/orgs/:orgId/employees"],
      ["a number", 42],
      ["an object whose path is not a string", { path: { toString: () => "nope" } }],
    ])("degrades to req.url rather than throwing when route is %s", async (_label, route) => {
      // `null` and the primitives are the shapes the cast's type forbids and
      // optional chaining survives; the last one is the shape it PERMITS
      // structurally while the value is not a string — the action is built by
      // interpolation, so this documents what actually reaches the audit log.
      const action = await actionFor({ route });
      expect(action.startsWith("operator.get.")).toBe(true);
    });

    it("authorizes on the fallback rather than skipping the check", async () => {
      // The failure that would matter most is silent: a guard that swallowed the
      // missing route and returned early would let an ungranted operator through.
      const svc = makeService();
      const guard = new OperatorSessionGuard(
        makeReflector("read_customer_data"),
        svc as unknown as PlatformOperatorAccessService,
      );

      await guard.canActivate(makeContext({ userId: "op-alice", orgId: "org-1", omitRoute: true }));

      expect(svc.authorizeRequest).toHaveBeenCalledTimes(1);
      const [userId, orgId, scope] = svc.authorizeRequest.mock.calls[0] as [string, string, string];
      expect(userId).toBe("op-alice");
      expect(orgId).toBe("org-1");
      expect(scope).toBe("read_customer_data");
    });
  });
});
