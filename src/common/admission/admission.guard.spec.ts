import { ExecutionContext, ServiceUnavailableException } from "@nestjs/common";
import { ModuleRef, Reflector } from "@nestjs/core";
import type { CallHandler } from "@nestjs/common";
import { lastValueFrom, of, throwError } from "rxjs";
import type { AdmissionConfig } from "./admission.config";
import { AdmissionGuard } from "./admission.guard";
import { AdmissionInterceptor } from "./admission.interceptor";
import { AdmissionService } from "./admission.service";
import { WORK_CLASS_KEY } from "./work-class.decorator";

const BASE_CONFIG: AdmissionConfig = {
  maxConcurrent: 5,
  maxQueueDepth: 400,
  maxExecutionMs: 5_000,
  maxBodyBytes: 3_145_728,
  orgMaxConcurrent: 50,
  reservedFraction: 0.2,
  enabled: true,
};

function makeContext(opts: {
  workClass?: string;
  orgId?: string;
}): {
  ctx: ExecutionContext;
  req: Record<string, unknown>;
  res: { set: jest.Mock };
} {
  const req: Record<string, unknown> = {
    user: opts.orgId ? { orgId: opts.orgId } : undefined,
    _admissionOrgId: undefined,
  };
  const res = { set: jest.fn() };
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
    getAllAndOverride: jest.fn((key: string) =>
      key === WORK_CLASS_KEY ? workClass : undefined,
    ),
  } as unknown as Reflector;
}

function makeModuleRef(): ModuleRef {
  return {
    get: jest.fn(() => {
      throw new Error("provider not found");
    }),
  } as unknown as ModuleRef;
}

describe("AdmissionGuard — refusal carries retry information", () => {
  it("throws ServiceUnavailableException with retryAfterSeconds in body", () => {
    const svc = new AdmissionService({ ...BASE_CONFIG, maxConcurrent: 1, reservedFraction: 0 });
    svc.tryAdmit("ordinary-write", "org-fill");
    const guard = new AdmissionGuard(makeReflector("ordinary-write"), svc, makeModuleRef());
    const { ctx } = makeContext({ workClass: "ordinary-write", orgId: "org-b" });
    expect(() => guard.canActivate(ctx)).toThrow(ServiceUnavailableException);
  });

  it("sets Retry-After header on refusal", () => {
    const svc = new AdmissionService({ ...BASE_CONFIG, maxConcurrent: 1, reservedFraction: 0 });
    svc.tryAdmit("ordinary-write", "org-fill");
    const guard = new AdmissionGuard(makeReflector("ordinary-write"), svc, makeModuleRef());
    const { ctx, res } = makeContext({ workClass: "ordinary-write", orgId: "org-b" });
    expect(() => guard.canActivate(ctx)).toThrow();
    expect(res.set).toHaveBeenCalledWith("Retry-After", expect.any(String));
    const retryAfter = Number(res.set.mock.calls[0]?.[1]);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it("includes retryAfterSeconds in the exception body", () => {
    const svc = new AdmissionService({ ...BASE_CONFIG, maxConcurrent: 1, reservedFraction: 0 });
    svc.tryAdmit("ordinary-write", "org-fill");
    const guard = new AdmissionGuard(makeReflector("ordinary-write"), svc, makeModuleRef());
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
    const guard = new AdmissionGuard(makeReflector(undefined), svc, makeModuleRef());
    const { ctx } = makeContext({ orgId: "org-b" });
    expect(() => guard.canActivate(ctx)).toThrow(ServiceUnavailableException);
  });

  it("is admitted at low load (ordinary-write threshold not reached)", () => {
    const svc = new AdmissionService(BASE_CONFIG);
    const guard = new AdmissionGuard(makeReflector(undefined), svc, makeModuleRef());
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
    const guard = new AdmissionGuard(makeReflector("ordinary-write"), svc, makeModuleRef());
    const { ctx: sheddableCtx } = makeContext({ workClass: "ordinary-write", orgId: "org-shed" });
    expect(() => guard.canActivate(sheddableCtx)).toThrow(ServiceUnavailableException);

    const svc2 = new AdmissionService(BASE_CONFIG);
    svc2.tryAdmit("authentication", "fill-1");
    svc2.tryAdmit("authentication", "fill-2");
    svc2.tryAdmit("authentication", "fill-3");
    svc2.tryAdmit("authentication", "fill-4");
    const guard2 = new AdmissionGuard(makeReflector("authentication"), svc2, makeModuleRef());
    const { ctx: reservedCtx } = makeContext({ workClass: "authentication", orgId: "org-reserved" });
    const result = guard2.canActivate(reservedCtx);
    expect(result).toBe(true);
  });
});

describe("AdmissionGuard + AdmissionInterceptor — in-flight counter lifecycle", () => {
  it("returns to zero after a successful handler", async () => {
    const svc = new AdmissionService(BASE_CONFIG);
    const reflector = makeReflector("ordinary-write");
    const guard = new AdmissionGuard(reflector, svc, makeModuleRef());
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
    const guard = new AdmissionGuard(reflector, svc, makeModuleRef());
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
    const guard = new AdmissionGuard(makeReflector("ordinary-write"), svc, makeModuleRef());
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
    const guard = new AdmissionGuard(makeReflector("ordinary-write"), svc, makeModuleRef());
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
