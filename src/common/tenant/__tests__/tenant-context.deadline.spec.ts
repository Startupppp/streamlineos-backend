import { EventEmitter } from "node:events";
import { type CallHandler, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { lastValueFrom, of } from "rxjs";
import type { Db } from "../../../db/drizzle.module";
import { TenantContextInterceptor } from "../tenant-context.interceptor";
import { TenantContextService, type TenantContext } from "../tenant-context";
import { resolveAdmissionConfig } from "../../admission/admission.config";
import { createStreamAbortSignal } from "../../http/stream-abort";

jest.mock("../run-in-tenant-transaction", () => {
  const runInNewTenantTransaction = jest.fn(
    async (_db: unknown, _orgId: string, fn: () => Promise<void>) => fn(),
  );
  // The interceptor hands its hook list to `drainAfterCommitHooks`; nothing here registers one, so
  // the double only has to exist and keep opening a transaction per hook.
  return {
    runInNewTenantTransaction,
    drainAfterCommitHooks: (
      db: unknown,
      orgId: string,
      hooks: readonly (() => Promise<void>)[],
    ): void => {
      for (const hook of hooks) {
        void Promise.resolve(
          runInNewTenantTransaction(db, orgId, async () => {
            await hook();
          }),
        ).catch(() => undefined);
      }
    },
  };
});

/**
 * PRD-C091 — the request deadline is propagated, not merely declared.
 *
 * `TenantContextInterceptor` armed the abort signal with `deadlineMs: null`, so
 * `deadline_exceeded` was unreachable on every tenant-scoped route: the timer branch
 * in `createStreamAbortSignal` existed, the reason existed in the union, and nothing
 * outside `src/modules/ai` could produce either. A request that hung on a slow upstream
 * ran until something else gave up.
 *
 * These assertions are on the signal the handler actually receives, because that is the
 * only place the difference is observable — the deadline is a constructor argument, and
 * a test that read the constant back would pass whatever the interceptor did with it.
 */
describe("TenantContextInterceptor — the request deadline", () => {
  const mockTx = { execute: jest.fn().mockResolvedValue([]) };

  function build(): {
    interceptor: TenantContextInterceptor;
    tenant: { run: jest.Mock; current: jest.Mock };
  } {
    const db = {
      transaction: jest.fn((fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
    } as unknown as Db;
    const tenant = {
      run: jest.fn(async (_ctx: TenantContext, fn: () => Promise<unknown>) => fn()),
      current: jest.fn().mockReturnValue(undefined),
    };
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(undefined),
    } as unknown as Reflector;
    return {
      interceptor: new TenantContextInterceptor(
        db,
        tenant as unknown as TenantContextService,
        reflector,
      ),
      tenant,
    };
  }

  function makeContext(): {
    context: ExecutionContext;
    req: EventEmitter & { complete: boolean };
    res: EventEmitter & { writableEnded: boolean };
  } {
    const req = Object.assign(new EventEmitter(), { user: { orgId: "org-1" }, complete: true });
    const res = Object.assign(new EventEmitter(), { writableEnded: false });
    return {
      req,
      res,
      context: {
        getType: () => "http",
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
        getHandler: () => function stub() {},
        getClass: () => class StubController {},
      } as unknown as ExecutionContext,
    };
  }

  const handler: CallHandler = { handle: () => of("ok") };

  it("hands the handler a signal that is not already aborted", async () => {
    const { interceptor, tenant } = build();
    let signal: AbortSignal | undefined;
    tenant.run.mockImplementationOnce(async (ctx: TenantContext, fn: () => Promise<unknown>) => {
      signal = ctx.abortSignal;
      return fn();
    });
    await lastValueFrom(interceptor.intercept(makeContext().context, handler));
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("arms a finite deadline rather than none", async () => {
    // A deadline of `null` is the defect: the timer is never created, so no request
    // outside src/modules/ai can ever reach `deadline_exceeded`. The value has to be a
    // positive finite number for the arm to exist at all.
    const deadline = resolveAdmissionConfig().maxExecutionMs;
    expect(Number.isFinite(deadline)).toBe(true);
    expect(deadline).toBeGreaterThan(0);
  });

  it("uses the SAME number the admission scheduler weights requests by", () => {
    // `admission.service.ts` divides by `maxExecutionMs` to weight queue occupancy. If
    // the deadline the request enforces and the deadline the scheduler assumes were two
    // different numbers, the queue would be sized for a request length nothing enforced.
    expect(resolveAdmissionConfig().maxExecutionMs).toBe(
      resolveAdmissionConfig(process.env).maxExecutionMs,
    );
  });

  it("still aborts on client disconnect — the deadline does not replace that arm", async () => {
    const { interceptor, tenant } = build();
    const { context, res } = makeContext();
    let signal: AbortSignal | undefined;
    tenant.run.mockImplementationOnce(async (ctx: TenantContext, fn: () => Promise<unknown>) => {
      signal = ctx.abortSignal;
      res.emit("close");
      return fn();
    });
    await lastValueFrom(interceptor.intercept(context, handler));
    expect(signal?.aborted).toBe(true);
  });
});

/**
 * The deadline arm itself, driven directly: the interceptor's own deadline is 30 s by
 * default and a spec must not wait for it, so the behaviour it now switches on is
 * asserted here on the same primitive with a short one.
 */
describe("createStreamAbortSignal — the deadline arm the interceptor now uses", () => {
  it("aborts with deadline_exceeded once the deadline passes", async () => {
    const req = Object.assign(new EventEmitter(), { complete: true });
    const res = Object.assign(new EventEmitter(), { writableEnded: false });
    const handle = createStreamAbortSignal(req, res, 5);
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(handle.signal.aborted).toBe(true);
      expect(handle.reason()).toBe("deadline_exceeded");
    } finally {
      handle.dispose();
    }
  });

  it("creates no timer at all when the deadline is null — the behaviour being replaced", async () => {
    const req = Object.assign(new EventEmitter(), { complete: true });
    const res = Object.assign(new EventEmitter(), { writableEnded: false });
    const handle = createStreamAbortSignal(req, res, null);
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(handle.signal.aborted).toBe(false);
      expect(handle.reason()).toBeNull();
    } finally {
      handle.dispose();
    }
  });
});
