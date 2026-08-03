import { type CallHandler, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { lastValueFrom, of } from "rxjs";
import type { Db } from "../../../db/drizzle.module";
import { NO_TENANT_TRANSACTION } from "../no-tenant-transaction.decorator";
import { TenantContextInterceptor } from "../tenant-context.interceptor";
import { TenantContextService, type TenantContext } from "../tenant-context";

type MockDb = { transaction: jest.Mock };
type MockTenant = { run: jest.Mock; current: jest.Mock };
type MockReflector = { getAllAndOverride: jest.Mock };

describe("TenantContextInterceptor", () => {
  const mockExecute = jest.fn().mockResolvedValue([]);
  const mockTx = { execute: mockExecute };

  let mockDb: MockDb;
  let mockTenant: MockTenant;
  let mockReflector: MockReflector;
  let interceptor: TenantContextInterceptor;

  beforeEach(() => {
    mockExecute.mockClear();

    mockDb = {
      transaction: jest.fn().mockImplementation(
        (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx),
      ),
    };

    mockTenant = {
      run: jest.fn().mockImplementation(
        async (_ctx: TenantContext, fn: () => Promise<unknown>) => fn(),
      ),
      current: jest.fn().mockReturnValue(undefined),
    };

    mockReflector = {
      getAllAndOverride: jest.fn().mockReturnValue(undefined),
    };

    interceptor = new TenantContextInterceptor(
      mockDb as unknown as Db,
      mockTenant as unknown as TenantContextService,
      mockReflector as unknown as Reflector,
    );
  });

  function makeHttpContext(req: object, handler = function stub() {}): ExecutionContext {
    return {
      getType: () => "http",
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => handler,
      getClass: () => class StubController {},
    } as unknown as ExecutionContext;
  }

  function makeCallHandler(value: unknown = "response"): CallHandler {
    return { handle: () => of(value) };
  }

  it("opens a tenant transaction with INTERNAL audience for a request carrying user.orgId", async () => {
    const ctx = makeHttpContext({ user: { orgId: "org-user" } });

    await lastValueFrom(interceptor.intercept(ctx, makeCallHandler()));

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockTenant.run).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-user", audience: "INTERNAL" }),
      expect.any(Function),
    );
  });

  it("uses PORTAL audience for a request carrying portalUser.organizationId and portal takes precedence over user.orgId when both are present", async () => {
    const ctx = makeHttpContext({
      user: { orgId: "org-user" },
      portalUser: { organizationId: "org-portal" },
    });

    await lastValueFrom(interceptor.intercept(ctx, makeCallHandler()));

    expect(mockTenant.run).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-portal", audience: "PORTAL" }),
      expect.any(Function),
    );
    const callArgs = mockTenant.run.mock.calls[0] as [TenantContext, unknown];
    expect(callArgs[0].orgId).toBe("org-portal");
  });

  it("passes straight through when the request has no orgId on either user or portalUser", async () => {
    const ctx = makeHttpContext({ user: {} });

    await lastValueFrom(interceptor.intercept(ctx, makeCallHandler()));

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("passes straight through when user.orgId is the empty string (signed-in user with no workspace)", async () => {
    const ctx = makeHttpContext({ user: { orgId: "" } });

    await lastValueFrom(interceptor.intercept(ctx, makeCallHandler()));

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("skips the transaction when the handler is marked with NoTenantTransaction metadata", async () => {
    function markedHandler() {}
    mockReflector.getAllAndOverride.mockImplementation(
      (key: unknown, targets: unknown[]) =>
        key === NO_TENANT_TRANSACTION && targets.includes(markedHandler) ? true : undefined,
    );
    const ctx = makeHttpContext({ user: { orgId: "org-user" } }, markedHandler);

    await lastValueFrom(interceptor.intercept(ctx, makeCallHandler()));

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("passes straight through for non-HTTP execution contexts", async () => {
    const wsCtx = {
      getType: () => "ws",
    } as unknown as ExecutionContext;

    await lastValueFrom(interceptor.intercept(wsCtx, makeCallHandler()));

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});
