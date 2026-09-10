import { ExecutionContext, ServiceUnavailableException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { CallHandler } from "@nestjs/common";
import { lastValueFrom, of, throwError } from "rxjs";
import type { AdmissionConfig } from "./admission.config";
import { AdmissionGuard } from "./admission.guard";
import { AdmissionInterceptor } from "./admission.interceptor";
import { AdmissionService } from "./admission.service";

const BASE_CONFIG: AdmissionConfig = {
  maxConcurrent: 5,
  maxQueueDepth: 400,
  maxExecutionMs: 5_000,
  maxBodyBytes: 3_145_728,
  orgMaxConcurrent: 50,
  reservedFraction: 0.2,
  enabled: true,
};

/** The half of `express.Response` admission touches, plus a way to fire it. */
interface ResponseDouble {
  set: jest.Mock;
  on: jest.Mock;
  finish: () => void;
  close: () => void;
}

function makeContext(opts: {
  workClass?: string;
  orgId?: string;
}): {
  ctx: ExecutionContext;
  req: Record<string, unknown>;
  res: ResponseDouble;
} {
  const req: Record<string, unknown> = {
    user: opts.orgId ? { orgId: opts.orgId } : undefined,
    _admissionOrgId: undefined,
  };
  /**
   * A response that can actually END, because that is the whole question.
   *
   * The old double had `set` and nothing else, so a guard could not register a
   * completion listener on it and no test could observe one being called. A
   * double shaped like the half of the interface the code used to touch is how
   * the leak below stayed invisible.
   */
  const listeners = new Map<string, (() => void)[]>();
  const res: ResponseDouble = {
    set: jest.fn(),
    on: jest.fn((event: string, fn: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return res;
    }),
    /** Fire what express would fire when the response is sent. */
    finish: () => {
      for (const fn of listeners.get("finish") ?? []) fn();
    },
    /** Fire what express would fire if the connection dropped first. */
    close: () => {
      for (const fn of listeners.get("close") ?? []) fn();
    },
  };
  const ctx = {
    getType: () => "http",
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { ctx, req, res };
}

function makeReflector(workClass: string | undefined): Reflector {
  return {
    getAllAndOverride: jest.fn().mockReturnValue(workClass),
  } as unknown as Reflector;
}

describe("AdmissionGuard — refusal carries retry information", () => {
  it("throws ServiceUnavailableException with retryAfterSeconds in body", () => {
    const svc = new AdmissionService({ ...BASE_CONFIG, maxConcurrent: 1, reservedFraction: 0 });
    svc.tryAdmit("ordinary-write", "org-fill");
    const guard = new AdmissionGuard(makeReflector("ordinary-write"), svc);
    const { ctx } = makeContext({ workClass: "ordinary-write", orgId: "org-b" });
    expect(() => guard.canActivate(ctx)).toThrow(ServiceUnavailableException);
  });

  it("sets Retry-After header on refusal", () => {
    const svc = new AdmissionService({ ...BASE_CONFIG, maxConcurrent: 1, reservedFraction: 0 });
    svc.tryAdmit("ordinary-write", "org-fill");
    const guard = new AdmissionGuard(makeReflector("ordinary-write"), svc);
    const { ctx, res } = makeContext({ workClass: "ordinary-write", orgId: "org-b" });
    expect(() => guard.canActivate(ctx)).toThrow();
    expect(res.set).toHaveBeenCalledWith("Retry-After", expect.any(String));
    const retryAfter = Number(res.set.mock.calls[0]?.[1]);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it("includes retryAfterSeconds in the exception body", () => {
    const svc = new AdmissionService({ ...BASE_CONFIG, maxConcurrent: 1, reservedFraction: 0 });
    svc.tryAdmit("ordinary-write", "org-fill");
    const guard = new AdmissionGuard(makeReflector("ordinary-write"), svc);
    const { ctx } = makeContext({ workClass: "ordinary-write", orgId: "org-b" });
    let thrown: unknown;
    try {
      guard.canActivate(ctx);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    const body = (thrown as ServiceUnavailableException).getResponse() as Record<string, unknown>;
    expect(typeof body["retryAfterSeconds"]).toBe("number");
    expect(Number(body["retryAfterSeconds"])).toBeGreaterThan(0);
  });
});

describe("AdmissionGuard — unclassified route defaults to ordinary-write", () => {
  it("is refused when ordinary-write threshold is crossed", () => {
    const svc = new AdmissionService({ ...BASE_CONFIG, maxConcurrent: 4, reservedFraction: 0 });
    svc.tryAdmit("authentication", "org-fill");
    svc.tryAdmit("authentication", "org-fill");
    svc.tryAdmit("authentication", "org-fill");
    svc.tryAdmit("authentication", "org-fill");
    const guard = new AdmissionGuard(makeReflector(undefined), svc);
    const { ctx } = makeContext({ orgId: "org-b" });
    expect(() => guard.canActivate(ctx)).toThrow(ServiceUnavailableException);
  });

  it("is admitted at low load (ordinary-write threshold not reached)", () => {
    const svc = new AdmissionService(BASE_CONFIG);
    const guard = new AdmissionGuard(makeReflector(undefined), svc);
    const { ctx } = makeContext({ orgId: "org-a" });
    expect(() => guard.canActivate(ctx)).not.toThrow();
    expect(guard.canActivate(ctx)).toBe(true);
  });
});

describe("AdmissionGuard — reserved class survives sheddable saturation", () => {
  it("admits authentication when all sheddable capacity is exhausted", () => {
    const svc = new AdmissionService(BASE_CONFIG);
    svc.tryAdmit("authentication", "fill-1");
    svc.tryAdmit("authentication", "fill-2");
    svc.tryAdmit("authentication", "fill-3");
    svc.tryAdmit("authentication", "fill-4");
    const guard = new AdmissionGuard(makeReflector("ordinary-write"), svc);
    const { ctx: sheddableCtx } = makeContext({ workClass: "ordinary-write", orgId: "org-shed" });
    expect(() => guard.canActivate(sheddableCtx)).toThrow(ServiceUnavailableException);

    const svc2 = new AdmissionService(BASE_CONFIG);
    svc2.tryAdmit("authentication", "fill-1");
    svc2.tryAdmit("authentication", "fill-2");
    svc2.tryAdmit("authentication", "fill-3");
    svc2.tryAdmit("authentication", "fill-4");
    const guard2 = new AdmissionGuard(makeReflector("authentication"), svc2);
    const { ctx: reservedCtx } = makeContext({ workClass: "authentication", orgId: "org-reserved" });
    const result = guard2.canActivate(reservedCtx);
    expect(result).toBe(true);
  });
});

describe("AdmissionGuard + AdmissionInterceptor — in-flight counter lifecycle", () => {
  it("returns to zero after a successful handler", async () => {
    const svc = new AdmissionService(BASE_CONFIG);
    const reflector = makeReflector("ordinary-write");
    const guard = new AdmissionGuard(reflector, svc);
    const interceptor = new AdmissionInterceptor(svc);

    const req: Record<string, unknown> = {
      user: { orgId: "org-lifecycle" },
      _admissionOrgId: undefined,
    };
    const res = { set: jest.fn() };
    const ctx = {
      getType: () => "http",
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;

    guard.canActivate(ctx);
    expect(svc.snapshot().inFlight).toBe(1);

    const next = { handle: () => of("success") } as unknown as CallHandler;
    await lastValueFrom(interceptor.intercept(ctx, next));
    expect(svc.snapshot().inFlight).toBe(0);
  });

  it("returns to zero after a throwing handler", async () => {
    const svc = new AdmissionService(BASE_CONFIG);
    const reflector = makeReflector("ordinary-write");
    const guard = new AdmissionGuard(reflector, svc);
    const interceptor = new AdmissionInterceptor(svc);

    const req: Record<string, unknown> = {
      user: { orgId: "org-throw" },
      _admissionOrgId: undefined,
    };
    const res = { set: jest.fn() };
    const ctx = {
      getType: () => "http",
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;

    guard.canActivate(ctx);
    expect(svc.snapshot().inFlight).toBe(1);

    const next = {
      handle: () => throwError(() => new Error("handler error")),
    } as unknown as CallHandler;
    await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toThrow("handler error");
    expect(svc.snapshot().inFlight).toBe(0);
  });

  it("does not decrement when the guard refused admission (no _admissionOrgId set)", async () => {
    const svc = new AdmissionService({ ...BASE_CONFIG, maxConcurrent: 1, reservedFraction: 0 });
    svc.tryAdmit("ordinary-write", "org-fill");

    const req: Record<string, unknown> = {
      user: { orgId: "org-refused" },
      _admissionOrgId: undefined,
    };
    const res = { set: jest.fn() };
    const ctx = {
      getType: () => "http",
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;

    const interceptor = new AdmissionInterceptor(svc);
    const next = { handle: () => of("ok") } as unknown as CallHandler;
    await lastValueFrom(interceptor.intercept(ctx, next));
    expect(svc.snapshot().inFlight).toBe(1);
  });

  it("sets _admissionOrgId on the request when admitted", () => {
    const svc = new AdmissionService(BASE_CONFIG);
    const guard = new AdmissionGuard(makeReflector("ordinary-write"), svc);
    const req: Record<string, unknown> = {
      user: { orgId: "org-check" },
      _admissionOrgId: undefined,
    };
    const res = { set: jest.fn() };
    const ctx = {
      getType: () => "http",
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
    guard.canActivate(ctx);
    expect(req._admissionOrgId).toBe("org-check");
  });

  it("uses __public__ as orgId for unauthenticated requests", () => {
    const svc = new AdmissionService(BASE_CONFIG);
    const guard = new AdmissionGuard(makeReflector("ordinary-write"), svc);
    const req: Record<string, unknown> = { user: undefined, _admissionOrgId: undefined };
    const res = { set: jest.fn() };
    const ctx = {
      getType: () => "http",
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
    guard.canActivate(ctx);
    expect(req._admissionOrgId).toBe("__public__");
  });
});

/**
 * The leak that made a tenant-level denial of service reachable by any signed-in
 * user, and the property that closes it.
 *
 * `AdmissionGuard` is the THIRD global `APP_GUARD`; `MfaGuard` and `ModuleGuard`
 * run after it, and Nest runs interceptors only once every guard has passed. So
 * a request admitted here and then refused by a later guard — a 402 for a module
 * the org has not bought, a 403 for MFA — never reached `AdmissionInterceptor`,
 * and its slot was never given back. Not a slow leak either: `orgMaxConcurrent`
 * is 50 by default, so about fifty failed requests permanently exhaust an
 * organisation's budget and every subsequent request 503s forever.
 *
 * What makes it unmistakably a LEAK rather than a busy server is that
 * SEQUENTIAL requests do it. Concurrency cannot be exhausted by requests that do
 * not overlap; only an unreturned slot can.
 *
 * The fix does not make the interceptor smarter, because no interceptor can see
 * a request that never reached it. The slot is returned when the RESPONSE ends,
 * which happens for every outcome there is — success, a later guard throwing,
 * the exception filter answering, a client hanging up.
 */
describe("an admitted request always gives its slot back", () => {
  const config = { ...BASE_CONFIG, orgMaxConcurrent: 2 };

  function admit(svc: AdmissionService, orgId: string) {
    const { ctx, res } = makeContext({ orgId });
    new AdmissionGuard(new Reflector(), svc).canActivate(ctx);
    return res;
  }

  it("returns the slot when a LATER guard rejects, which no interceptor can see", () => {
    const svc = new AdmissionService(config);

    /* Three sequential requests. Each is admitted, then refused downstream. */
    for (let i = 0; i < 3; i++) {
      const res = admit(svc, "org-a");
      /* MfaGuard or ModuleGuard throws here. The interceptor never runs. */
      res.finish();
    }

    expect(svc.snapshot().inFlight).toBe(0);
    /* And the org can still be served — the point of the whole thing. */
    const { ctx } = makeContext({ orgId: "org-a" });
    expect(new AdmissionGuard(new Reflector(), svc).canActivate(ctx)).toBe(true);
  });

  it("does not double-release when the interceptor runs too", async () => {
    const svc = new AdmissionService(config);
    const { ctx, req, res } = makeContext({ orgId: "org-b" });

    new AdmissionGuard(new Reflector(), svc).canActivate(ctx);
    expect(svc.snapshot().inFlight).toBe(1);

    const handler = { handle: () => of("ok") } as unknown as CallHandler;
    await lastValueFrom(new AdmissionInterceptor(svc).intercept(ctx, handler));
    res.finish();

    expect(svc.snapshot().inFlight).toBe(0);
    /* A second org's slot must not have been eaten by an over-release. */
    expect(req._admissionOrgId).toBe("org-b");
  });

  it("returns the slot when the client hangs up before the response is sent", () => {
    const svc = new AdmissionService(config);
    const res = admit(svc, "org-c");
    expect(svc.snapshot().inFlight).toBe(1);

    res.close();
    expect(svc.snapshot().inFlight).toBe(0);
  });
});
