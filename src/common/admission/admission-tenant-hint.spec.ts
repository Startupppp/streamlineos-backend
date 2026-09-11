import { EventEmitter } from "node:events";
import { ExecutionContext, ServiceUnavailableException } from "@nestjs/common";
import type { CallHandler } from "@nestjs/common";
import { ModuleRef, Reflector } from "@nestjs/core";
import { lastValueFrom, of } from "rxjs";
import {
  ADMISSION_TENANT_HINT_KEY,
  hintedBucket,
  PUBLIC_ADMISSION_BUCKET,
  type AdmissionTenantHintProvider,
} from "./admission-tenant-hint";
import type { AdmissionConfig } from "./admission.config";
import { AdmissionGuard } from "./admission.guard";
import { AdmissionInterceptor } from "./admission.interceptor";
import { AdmissionService } from "./admission.service";
import type { WorkClass } from "./work-class";
import { WORK_CLASS_KEY } from "./work-class.decorator";

const BASE_CONFIG: AdmissionConfig = {
  maxConcurrent: 100,
  maxQueueDepth: 400,
  maxExecutionMs: 30_000,
  maxBodyBytes: 3_145_728,
  orgMaxConcurrent: 3,
  reservedFraction: 0,
  enabled: true,
};

class FakeResponse extends EventEmitter {
  readonly headers: Record<string, string> = {};

  set(name: string, value: string): this {
    this.headers[name] = value;
    return this;
  }

  finish(): void {
    this.emit("finish");
    this.emit("close");
  }

  abort(): void {
    this.emit("close");
  }
}

// A stand-in for NotificationEventService: server-minted opaque tokens, stored server-side against
// the org that minted them. The only thing a caller supplies is the token string.
class FakeStreamTokenStore implements AdmissionTenantHintProvider {
  private readonly tokens = new Map<string, { orgId: string; expiresAt: number }>();

  mint(orgId: string, ttlMs = 120_000): string {
    const token = `tok-${this.tokens.size}-${orgId}`;
    this.tokens.set(token, { orgId, expiresAt: Date.now() + ttlMs });
    return token;
  }

  consume(token: string): string | undefined {
    const entry = this.tokens.get(token);
    this.tokens.delete(token);
    if (!entry || entry.expiresAt < Date.now()) return undefined;
    return entry.orgId;
  }

  resolveAdmissionTenantOrgId(req: unknown): string | undefined {
    const token = bearerOf(req);
    if (token === undefined) return undefined;
    const entry = this.tokens.get(token);
    if (!entry || entry.expiresAt < Date.now()) return undefined;
    return entry.orgId;
  }
}

class ThrowingHintProvider implements AdmissionTenantHintProvider {
  resolveAdmissionTenantOrgId(): string | undefined {
    throw new Error("resolver blew up");
  }
}

// Deliberately not typed as an AdmissionTenantHintProvider: it exists to feed the guard the
// answers a buggy or hostile provider could return, which the type system alone cannot stop.
class LyingHintProvider {
  constructor(private readonly answer: unknown) {}

  resolveAdmissionTenantOrgId(): unknown {
    return this.answer;
  }
}

function bearerOf(req: unknown): string | undefined {
  if (typeof req !== "object" || req === null) return undefined;
  const candidate: { headers?: unknown } = req;
  const headers = candidate.headers;
  if (typeof headers !== "object" || headers === null) return undefined;
  const withAuth: { authorization?: unknown } = headers;
  const authorization = withAuth.authorization;
  if (typeof authorization !== "string") return undefined;
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined;
}

interface Harness {
  service: AdmissionService;
  guard: AdmissionGuard;
  interceptor: AdmissionInterceptor;
  releaseSpy: jest.SpyInstance;
}

function makeHarness(opts: {
  workClass?: WorkClass;
  hintProvider?: unknown;
  instances?: Map<unknown, unknown>;
  config?: AdmissionConfig;
}): Harness {
  const service = new AdmissionService(opts.config ?? BASE_CONFIG);
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === WORK_CLASS_KEY) return opts.workClass;
      if (key === ADMISSION_TENANT_HINT_KEY) return opts.hintProvider;
      return undefined;
    }),
  } as unknown as Reflector;
  const instances = opts.instances ?? new Map<unknown, unknown>();
  const moduleRef = {
    get: jest.fn((token: unknown) => {
      if (!instances.has(token)) throw new Error("provider not found");
      return instances.get(token);
    }),
  } as unknown as ModuleRef;
  return {
    service,
    guard: new AdmissionGuard(reflector, service, moduleRef),
    interceptor: new AdmissionInterceptor(service),
    releaseSpy: jest.spyOn(service, "release"),
  };
}

function makeStreamContext(
  authorization: string | undefined,
  res: FakeResponse,
  extras: Record<string, unknown> = {},
): { ctx: ExecutionContext; req: Record<string, unknown> } {
  const req: Record<string, unknown> = {
    user: undefined,
    path: "/notifications/events",
    headers: authorization === undefined ? {} : { authorization },
    ...extras,
  };
  const ctx = {
    getType: () => "http",
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

function makeAuthedContext(
  orgId: string,
  res: FakeResponse,
): { ctx: ExecutionContext; req: Record<string, unknown> } {
  const req: Record<string, unknown> = {
    user: { orgId },
    path: "/crm/leads",
    headers: {},
  };
  const ctx = {
    getType: () => "http",
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

function openStreams(
  harness: Harness,
  store: FakeStreamTokenStore,
  orgIds: readonly string[],
): { admitted: number; refused: number; responses: FakeResponse[] } {
  let admitted = 0;
  let refused = 0;
  const responses: FakeResponse[] = [];
  for (const orgId of orgIds) {
    const res = new FakeResponse();
    responses.push(res);
    const token = store.mint(orgId);
    const { ctx } = makeStreamContext(`Bearer ${token}`, res);
    try {
      harness.guard.canActivate(ctx);
      admitted += 1;
    } catch (e) {
      if (!(e instanceof ServiceUnavailableException)) throw e;
      refused += 1;
    }
  }
  return { admitted, refused, responses };
}

describe("admission bucketing — a public route that can identify its tenant", () => {
  it("documents the defect: without a hint, streams from different orgs share one public bucket", () => {
    const harness = makeHarness({ workClass: "ordinary-write" });
    const store = new FakeStreamTokenStore();

    const { admitted, refused } = openStreams(harness, store, [
      "org-a",
      "org-b",
      "org-c",
      "org-d",
    ]);

    expect(admitted).toBe(BASE_CONFIG.orgMaxConcurrent);
    expect(refused).toBe(1);
    expect(harness.service.snapshot().orgMapSize).toBe(1);
  });

  it("gives every org its own headroom once the route declares a tenant hint", () => {
    const store = new FakeStreamTokenStore();
    const instances = new Map<unknown, unknown>([[FakeStreamTokenStore, store]]);
    const harness = makeHarness({
      workClass: "non-mandatory-notification",
      hintProvider: FakeStreamTokenStore,
      instances,
    });

    const { admitted, refused } = openStreams(harness, store, [
      "org-a",
      "org-b",
      "org-c",
      "org-d",
      "org-e",
      "org-f",
    ]);

    expect(admitted).toBe(6);
    expect(refused).toBe(0);
    expect(harness.service.snapshot().orgMapSize).toBe(6);
    expect(harness.service.snapshot().inFlight).toBe(6);
  });

  it("still caps a single org at orgMaxConcurrent", () => {
    const store = new FakeStreamTokenStore();
    const instances = new Map<unknown, unknown>([[FakeStreamTokenStore, store]]);
    const harness = makeHarness({
      workClass: "non-mandatory-notification",
      hintProvider: FakeStreamTokenStore,
      instances,
    });

    const { admitted, refused } = openStreams(harness, store, [
      "org-a",
      "org-a",
      "org-a",
      "org-a",
      "org-a",
    ]);

    expect(admitted).toBe(BASE_CONFIG.orgMaxConcurrent);
    expect(refused).toBe(2);
    expect(harness.service.snapshot().orgMapSize).toBe(1);
  });

  it("stamps the hinted bucket, not the bare org id", () => {
    const store = new FakeStreamTokenStore();
    const instances = new Map<unknown, unknown>([[FakeStreamTokenStore, store]]);
    const harness = makeHarness({
      workClass: "non-mandatory-notification",
      hintProvider: FakeStreamTokenStore,
      instances,
    });

    const res = new FakeResponse();
    const { ctx, req } = makeStreamContext(`Bearer ${store.mint("org-a")}`, res);
    harness.guard.canActivate(ctx);

    expect(req["_admissionOrgId"]).toBe(hintedBucket("org-a"));
  });
});

describe("admission bucketing — the hint cannot become an authentication bypass", () => {
  it("buckets a forged token as public", () => {
    const store = new FakeStreamTokenStore();
    const instances = new Map<unknown, unknown>([[FakeStreamTokenStore, store]]);
    const harness = makeHarness({
      workClass: "non-mandatory-notification",
      hintProvider: FakeStreamTokenStore,
      instances,
    });

    const res = new FakeResponse();
    const { ctx, req } = makeStreamContext("Bearer tok-0-org-a", res);
    harness.guard.canActivate(ctx);

    expect(req["_admissionOrgId"]).toBe(PUBLIC_ADMISSION_BUCKET);
  });

  it("buckets an absent token as public", () => {
    const store = new FakeStreamTokenStore();
    const instances = new Map<unknown, unknown>([[FakeStreamTokenStore, store]]);
    const harness = makeHarness({
      workClass: "non-mandatory-notification",
      hintProvider: FakeStreamTokenStore,
      instances,
    });

    const res = new FakeResponse();
    const { ctx, req } = makeStreamContext(undefined, res);
    harness.guard.canActivate(ctx);

    expect(req["_admissionOrgId"]).toBe(PUBLIC_ADMISSION_BUCKET);
  });

  it("buckets an expired token as public", () => {
    const store = new FakeStreamTokenStore();
    const instances = new Map<unknown, unknown>([[FakeStreamTokenStore, store]]);
    const harness = makeHarness({
      workClass: "non-mandatory-notification",
      hintProvider: FakeStreamTokenStore,
      instances,
    });

    const res = new FakeResponse();
    const { ctx, req } = makeStreamContext(`Bearer ${store.mint("org-a", -1)}`, res);
    harness.guard.canActivate(ctx);

    expect(req["_admissionOrgId"]).toBe(PUBLIC_ADMISSION_BUCKET);
  });

  it("ignores an org id the caller supplies itself", () => {
    const store = new FakeStreamTokenStore();
    const instances = new Map<unknown, unknown>([[FakeStreamTokenStore, store]]);
    const harness = makeHarness({
      workClass: "non-mandatory-notification",
      hintProvider: FakeStreamTokenStore,
      instances,
    });

    const res = new FakeResponse();
    const { ctx, req } = makeStreamContext(undefined, res, {
      query: { orgId: "org-victim" },
      body: { orgId: "org-victim" },
      user: undefined,
    });
    harness.guard.canActivate(ctx);

    expect(req["_admissionOrgId"]).toBe(PUBLIC_ADMISSION_BUCKET);
  });

  it("never stamps the hint onto req.user", () => {
    const store = new FakeStreamTokenStore();
    const instances = new Map<unknown, unknown>([[FakeStreamTokenStore, store]]);
    const harness = makeHarness({
      workClass: "non-mandatory-notification",
      hintProvider: FakeStreamTokenStore,
      instances,
    });

    const res = new FakeResponse();
    const { ctx, req } = makeStreamContext(`Bearer ${store.mint("org-a")}`, res);
    harness.guard.canActivate(ctx);

    expect(req["user"]).toBeUndefined();
  });

  it("leaves the one-shot token unconsumed so the handler still verifies it", () => {
    const store = new FakeStreamTokenStore();
    const instances = new Map<unknown, unknown>([[FakeStreamTokenStore, store]]);
    const harness = makeHarness({
      workClass: "non-mandatory-notification",
      hintProvider: FakeStreamTokenStore,
      instances,
    });

    const token = store.mint("org-a");
    const res = new FakeResponse();
    const { ctx } = makeStreamContext(`Bearer ${token}`, res);
    harness.guard.canActivate(ctx);

    expect(store.consume(token)).toBe("org-a");
    expect(store.consume(token)).toBeUndefined();
  });

  it("buckets as public when the resolver throws", () => {
    const instances = new Map<unknown, unknown>([
      [ThrowingHintProvider, new ThrowingHintProvider()],
    ]);
    const harness = makeHarness({
      workClass: "non-mandatory-notification",
      hintProvider: ThrowingHintProvider,
      instances,
    });

    const res = new FakeResponse();
    const { ctx, req } = makeStreamContext("Bearer anything", res);
    expect(() => harness.guard.canActivate(ctx)).not.toThrow();
    expect(req["_admissionOrgId"]).toBe(PUBLIC_ADMISSION_BUCKET);
  });

  it("buckets as public when the declared provider is not in the container", () => {
    const harness = makeHarness({
      workClass: "non-mandatory-notification",
      hintProvider: FakeStreamTokenStore,
      instances: new Map<unknown, unknown>(),
    });

    const res = new FakeResponse();
    const { ctx, req } = makeStreamContext("Bearer anything", res);
    expect(() => harness.guard.canActivate(ctx)).not.toThrow();
    expect(req["_admissionOrgId"]).toBe(PUBLIC_ADMISSION_BUCKET);
  });

  it.each<[string, unknown]>([
    ["a non-string answer", 42],
    ["an over-long answer", "x".repeat(65)],
    ["a namespace-forging answer", "hint:org-a"],
    ["an empty answer", ""],
  ])("buckets as public for %s", (_label, answer) => {
    const provider = new LyingHintProvider(answer);
    const instances = new Map<unknown, unknown>([[LyingHintProvider, provider]]);
    const harness = makeHarness({
      workClass: "non-mandatory-notification",
      hintProvider: LyingHintProvider,
      instances,
    });

    const res = new FakeResponse();
    const { ctx, req } = makeStreamContext("Bearer anything", res);
    harness.guard.canActivate(ctx);

    expect(req["_admissionOrgId"]).toBe(PUBLIC_ADMISSION_BUCKET);
  });

  it("keeps a hinted bucket disjoint from the same org's authenticated bucket", async () => {
    const store = new FakeStreamTokenStore();
    const instances = new Map<unknown, unknown>([[FakeStreamTokenStore, store]]);
    const harness = makeHarness({
      workClass: "non-mandatory-notification",
      hintProvider: FakeStreamTokenStore,
      instances,
    });

    const authedRes = new FakeResponse();
    const { ctx: authedCtx } = makeAuthedContext("org-a", authedRes);
    harness.guard.canActivate(authedCtx);

    const streamRes = new FakeResponse();
    const { ctx: streamCtx } = makeStreamContext(`Bearer ${store.mint("org-a")}`, streamRes);
    harness.guard.canActivate(streamCtx);

    expect(harness.service.snapshot().orgMapSize).toBe(2);
    expect(harness.service.snapshot().inFlight).toBe(2);

    await lastValueFrom(
      harness.interceptor.intercept(streamCtx, {
        handle: () => of("ok"),
      } as unknown as CallHandler),
    );
    streamRes.finish();

    expect(harness.service.snapshot().inFlight).toBe(1);
    expect(harness.releaseSpy).toHaveBeenCalledTimes(1);
    expect(harness.releaseSpy).toHaveBeenCalledWith(hintedBucket("org-a"));
  });
});

describe("admission bucketing — a long-lived stream releases exactly once", () => {
  it("releases exactly once when the client disconnects", async () => {
    const store = new FakeStreamTokenStore();
    const instances = new Map<unknown, unknown>([[FakeStreamTokenStore, store]]);
    const harness = makeHarness({
      workClass: "non-mandatory-notification",
      hintProvider: FakeStreamTokenStore,
      instances,
    });

    const res = new FakeResponse();
    const { ctx } = makeStreamContext(`Bearer ${store.mint("org-a")}`, res);
    harness.guard.canActivate(ctx);
    expect(harness.service.snapshot().inFlight).toBe(1);

    res.abort();
    res.finish();

    expect(harness.service.snapshot().inFlight).toBe(0);
    expect(harness.releaseSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps a sibling stream of the same org when one of them ends", () => {
    const store = new FakeStreamTokenStore();
    const instances = new Map<unknown, unknown>([[FakeStreamTokenStore, store]]);
    const harness = makeHarness({
      workClass: "non-mandatory-notification",
      hintProvider: FakeStreamTokenStore,
      instances,
    });

    const firstRes = new FakeResponse();
    const { ctx: firstCtx } = makeStreamContext(`Bearer ${store.mint("org-a")}`, firstRes);
    harness.guard.canActivate(firstCtx);

    const secondRes = new FakeResponse();
    const { ctx: secondCtx } = makeStreamContext(`Bearer ${store.mint("org-a")}`, secondRes);
    harness.guard.canActivate(secondCtx);

    expect(harness.service.snapshot().inFlight).toBe(2);

    secondRes.finish();

    expect(harness.service.snapshot().inFlight).toBe(1);
    expect(harness.releaseSpy).toHaveBeenCalledTimes(1);
  });
});

describe("admission bucketing — a stream is still shed under real pressure", () => {
  const PRESSURE_CONFIG: AdmissionConfig = {
    ...BASE_CONFIG,
    maxConcurrent: 12,
    orgMaxConcurrent: 50,
    reservedFraction: 0,
  };

  it("sheds a notification stream before an ordinary write", () => {
    const store = new FakeStreamTokenStore();
    const instances = new Map<unknown, unknown>([[FakeStreamTokenStore, store]]);
    const streamHarness = makeHarness({
      workClass: "non-mandatory-notification",
      hintProvider: FakeStreamTokenStore,
      instances,
      config: PRESSURE_CONFIG,
    });

    for (let i = 0; i < 10; i += 1) streamHarness.service.tryAdmit("ordinary-write", `filler-${i}`);
    expect(streamHarness.service.snapshot().inFlight).toBe(10);

    const res = new FakeResponse();
    const { ctx } = makeStreamContext(`Bearer ${store.mint("org-a")}`, res);
    expect(() => streamHarness.guard.canActivate(ctx)).toThrow(ServiceUnavailableException);

    expect(streamHarness.service.tryAdmit("ordinary-write", "org-b")).toEqual({ admitted: true });
  });
});
