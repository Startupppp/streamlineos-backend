import { BadRequestException, ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { OPERATOR_GRANT_KEY } from "./require-operator-grant.decorator";
import { OperatorSessionGuard } from "./operator-session.guard";
import type { PlatformOperatorAccessService } from "./platform-operator-access.service";

type MockOperatorService = {
  assertAndLog: jest.Mock;
};

function makeService(opts: { throws?: Error } = {}): MockOperatorService {
  return {
    assertAndLog: opts.throws
      ? jest.fn().mockRejectedValue(opts.throws)
      : jest.fn().mockResolvedValue(undefined),
  };
}

function makeReflector(scope: string | undefined): Reflector {
  return { get: jest.fn().mockReturnValue(scope) } as unknown as Reflector;
}

function makeContext(opts: {
  userId?: string;
  orgId?: string;
  method?: string;
}): ExecutionContext {
  const req = {
    user: opts.userId !== undefined ? { userId: opts.userId } : undefined,
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
      expect(svc.assertAndLog).not.toHaveBeenCalled();
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
      expect(svc.assertAndLog).toHaveBeenCalledTimes(1);
    });

    it("returns true and calls assertAndLog when an active grant exists", async () => {
      const svc = makeService();
      const guard = new OperatorSessionGuard(
        makeReflector("read_customer_data"),
        svc as unknown as PlatformOperatorAccessService,
      );
      const result = await guard.canActivate(makeContext({ userId: "op-alice", orgId: "org-1" }));
      expect(result).toBe(true);
      expect(svc.assertAndLog).toHaveBeenCalledWith(
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
      expect(svc.assertAndLog).not.toHaveBeenCalled();
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
      expect(svc.assertAndLog).not.toHaveBeenCalled();
    });

    it("passes scope, operatorUserId and orgId to assertAndLog — cross-org isolation enforced by the service", async () => {
      const svc = makeService();
      const guard = new OperatorSessionGuard(
        makeReflector("read_payments"),
        svc as unknown as PlatformOperatorAccessService,
      );
      await guard.canActivate(makeContext({ userId: "op-charlie", orgId: "org-acme" }));
      const [userId, orgId, scope] = svc.assertAndLog.mock.calls[0] as [string, string, string];
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
      const [, , , action] = svc.assertAndLog.mock.calls[0] as [string, string, string, string];
      expect(action).toContain("operator.");
      expect(action.toLowerCase()).toContain("post");
    });
  });
});
