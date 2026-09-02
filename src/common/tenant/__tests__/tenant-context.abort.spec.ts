import { EventEmitter } from "node:events";
import { type CallHandler, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { lastValueFrom, of } from "rxjs";
import type { Db } from "../../../db/drizzle.module";
import { TenantContextInterceptor } from "../tenant-context.interceptor";
import { TenantContextService, type TenantContext } from "../tenant-context";
import { runInNewTenantTransaction } from "../run-in-tenant-transaction";

jest.mock("../run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));

type MockDb = { transaction: jest.Mock };
type MockTenant = { run: jest.Mock; current: jest.Mock };
type MockReflector = { getAllAndOverride: jest.Mock };

describe("TenantContextInterceptor — abort signal on client disconnect", () => {
  const mockExecute = jest.fn().mockResolvedValue([]);
  const mockTx = { execute: mockExecute };

  let mockDb: MockDb;
  let mockTenant: MockTenant;
  let mockReflector: MockReflector;
  let interceptor: TenantContextInterceptor;

  const mockRunInNew = runInNewTenantTransaction as jest.MockedFunction<
    typeof runInNewTenantTransaction
  >;

  beforeEach(() => {
    mockExecute.mockClear();
    mockRunInNew.mockClear();
    mockRunInNew.mockImplementation(async (_db, _orgId, fn) => {
      await (fn as unknown as () => Promise<void>)();
    });

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

  function makeCallHandler(value: unknown = "response"): CallHandler {
    return { handle: () => of(value) };
  }

  /**
   * Express drains the body before a handler runs, so on a healthy request
   * `req` is already `complete` and emits `close`. The response is what stays
   * open for the length of the call. A fake response without `on`/`off` cannot
   * express either fact, which is how the previous version of this file passed
   * while the interceptor aborted every healthy transactional request.
   */
  function makeReq(orgId: string, complete: boolean) {
    return Object.assign(new EventEmitter(), { user: { orgId }, complete });
  }

  function makeRes(writableEnded: boolean) {
    return Object.assign(new EventEmitter(), { writableEnded });
  }

  function makeContext(
    req: EventEmitter & { user?: { orgId?: string } },
    res: EventEmitter & { writableEnded: boolean },
  ): ExecutionContext {
    return {
      getType: () => "http",
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
      getHandler: () => function stub() {},
      getClass: () => class StubController {},
    } as unknown as ExecutionContext;
  }

  it("aborts the signal when close fires before the response is sent", async () => {
    let capturedSignal: AbortSignal | undefined;

    const req = makeReq("org-abort", false);
    const res = makeRes(false);

    mockTenant.run.mockImplementationOnce(
      async (ctx: TenantContext, fn: () => Promise<unknown>) => {
        capturedSignal = ctx.abortSignal;
        req.emit("close");
        return fn();
      },
    );

    await lastValueFrom(interceptor.intercept(makeContext(req, res), makeCallHandler()));

    expect(capturedSignal?.aborted).toBe(true);
  });

  it("does not abort the signal when close fires after the response is already sent", async () => {
    let capturedSignal: AbortSignal | undefined;

    const req = makeReq("org-normal", true);
    const res = makeRes(true);

    mockTenant.run.mockImplementationOnce(
      async (ctx: TenantContext, fn: () => Promise<unknown>) => {
        capturedSignal = ctx.abortSignal;
        req.emit("close");
        return fn();
      },
    );

    await lastValueFrom(interceptor.intercept(makeContext(req, res), makeCallHandler()));

    expect(capturedSignal?.aborted).toBe(false);
  });

  it("does NOT abort a healthy request whose body simply finished arriving", async () => {
    let capturedSignal: AbortSignal | undefined;

    const req = makeReq("org-healthy", true);
    const res = makeRes(false);

    mockTenant.run.mockImplementationOnce(
      async (ctx: TenantContext, fn: () => Promise<unknown>) => {
        capturedSignal = ctx.abortSignal;
        req.emit("close");
        return fn();
      },
    );

    await lastValueFrom(interceptor.intercept(makeContext(req, res), makeCallHandler()));

    expect(capturedSignal?.aborted).toBe(false);
  });

  it("aborts when the response closes before it finished — a real client hang-up", async () => {
    let capturedSignal: AbortSignal | undefined;

    const req = makeReq("org-hangup", true);
    const res = makeRes(false);

    mockTenant.run.mockImplementationOnce(
      async (ctx: TenantContext, fn: () => Promise<unknown>) => {
        capturedSignal = ctx.abortSignal;
        res.emit("close");
        return fn();
      },
    );

    await lastValueFrom(interceptor.intercept(makeContext(req, res), makeCallHandler()));

    expect(capturedSignal?.aborted).toBe(true);
  });

  it("still runs after-commit hooks even when the client disconnected during the request", async () => {
    let hookResolve!: () => void;
    const hookSettled = new Promise<void>((r) => {
      hookResolve = r;
    });
    const hook = jest.fn().mockImplementation(async () => {
      hookResolve();
    });

    const req = makeReq("org-hook-disconnect", false);
    const res = makeRes(false);

    mockTenant.run.mockImplementationOnce(
      async (ctx: TenantContext, fn: () => Promise<unknown>) => {
        ctx.afterCommit!.push(hook);
        req.emit("close");
        return fn();
      },
    );

    await lastValueFrom(interceptor.intercept(makeContext(req, res), makeCallHandler()));

    await hookSettled;

    expect(hook).toHaveBeenCalledTimes(1);
  });
});
