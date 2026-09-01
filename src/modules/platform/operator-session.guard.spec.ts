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
    route: { path: "/platform/admin/orgs/:orgId/employees" },
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
});
