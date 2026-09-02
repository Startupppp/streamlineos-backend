import { EventEmitter } from "node:events";
import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { CallHandler } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { lastValueFrom, of, Subject, throwError, type Observable } from "rxjs";
import type { AdmissionConfig } from "./admission.config";
import { AdmissionGuard } from "./admission.guard";
import { AdmissionInterceptor } from "./admission.interceptor";
import { AdmissionService } from "./admission.service";
import type { WorkClass } from "./work-class";

const BASE_CONFIG: AdmissionConfig = {
  maxConcurrent: 20,
  maxQueueDepth: 400,
  maxExecutionMs: 5_000,
  maxBodyBytes: 3_145_728,
  orgMaxConcurrent: 50,
  reservedFraction: 0.2,
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

interface Pipeline {
  service: AdmissionService;
  guard: AdmissionGuard;
  interceptor: AdmissionInterceptor;
  releaseSpy: jest.SpyInstance;
}

function makePipeline(workClass: WorkClass | undefined, config = BASE_CONFIG): Pipeline {
  const service = new AdmissionService(config);
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(workClass),
  } as unknown as Reflector;
  return {
    service,
    guard: new AdmissionGuard(reflector, service),
    interceptor: new AdmissionInterceptor(service),
    releaseSpy: jest.spyOn(service, "release"),
  };
}

function makeContext(
  orgId: string | undefined,
  res: FakeResponse,
  type: "http" | "rpc" = "http",
): { ctx: ExecutionContext; req: Record<string, unknown> } {
  const req: Record<string, unknown> = {
    user: orgId === undefined ? undefined : { orgId },
    path: "/crm/leads",
  };
  const ctx = {
    getType: () => type,
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

function handlerOf(next: () => Observable<unknown>): CallHandler {
  return { handle: next } as unknown as CallHandler;
}

async function runRequest(opts: {
  pipeline: Pipeline;
  orgId?: string;
  downstreamGuards?: Array<() => void>;
  handler?: () => Observable<unknown>;
}): Promise<{ res: FakeResponse; error: unknown }> {
  const { pipeline } = opts;
  const res = new FakeResponse();
  const { ctx } = makeContext(opts.orgId ?? "org-a", res);
  let error: unknown;
  try {
    pipeline.guard.canActivate(ctx);
    for (const downstream of opts.downstreamGuards ?? []) downstream();
    const handler = handlerOf(opts.handler ?? (() => of("ok")));
    await lastValueFrom(pipeline.interceptor.intercept(ctx, handler));
  } catch (e) {
    error = e;
  }
  res.finish();
  return { res, error };
}

describe("admission slot lifecycle — every admitted request releases exactly once", () => {
  it("releases the slot when a downstream guard rejects with 403", async () => {
    const pipeline = makePipeline("ordinary-write");
    const { error } = await runRequest({
      pipeline,
      downstreamGuards: [
        () => {
          throw new ForbiddenException("permission denied");
        },
      ],
    });

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(pipeline.service.snapshot().inFlight).toBe(0);
    expect(pipeline.service.snapshot().orgMapSize).toBe(0);
    expect(pipeline.releaseSpy).toHaveBeenCalledTimes(1);
  });

  it("does not leak across a burst of 403s", async () => {
    const pipeline = makePipeline("ordinary-write");
    for (let i = 0; i < 50; i += 1)
      await runRequest({
        pipeline,
        downstreamGuards: [
          () => {
            throw new ForbiddenException("permission denied");
          },
        ],
      });

    expect(pipeline.service.snapshot().inFlight).toBe(0);
    expect(pipeline.releaseSpy).toHaveBeenCalledTimes(50);

    const survivor = new FakeResponse();
    const { ctx } = makeContext("org-after-burst", survivor);
    expect(() => pipeline.guard.canActivate(ctx)).not.toThrow();
  });

  it("releases the slot when a downstream guard rejects with 429", async () => {
    const pipeline = makePipeline("ordinary-write");
    const { error } = await runRequest({
      pipeline,
      downstreamGuards: [
        () => {
          throw new HttpException("rate limited", HttpStatus.TOO_MANY_REQUESTS);
        },
      ],
    });

    expect(error).toBeInstanceOf(HttpException);
    expect(pipeline.service.snapshot().inFlight).toBe(0);
    expect(pipeline.releaseSpy).toHaveBeenCalledTimes(1);
  });

  it("releases exactly once when the handler throws", async () => {
    const pipeline = makePipeline("ordinary-write");
    const { error } = await runRequest({
      pipeline,
      handler: () => throwError(() => new Error("handler blew up")),
    });

    expect(error).toBeInstanceOf(Error);
    expect(pipeline.service.snapshot().inFlight).toBe(0);
    expect(pipeline.releaseSpy).toHaveBeenCalledTimes(1);
  });

  it("releases exactly once on a successful request", async () => {
    const pipeline = makePipeline("ordinary-write");
    const { error } = await runRequest({ pipeline });

    expect(error).toBeUndefined();
    expect(pipeline.service.snapshot().inFlight).toBe(0);
    expect(pipeline.releaseSpy).toHaveBeenCalledTimes(1);
  });

  it("releases the slot when the client disconnects mid-response", async () => {
    const pipeline = makePipeline("ordinary-write");
    const res = new FakeResponse();
    const { ctx } = makeContext("org-disconnect", res);
    const pending = new Subject<unknown>();

    pipeline.guard.canActivate(ctx);
    expect(pipeline.service.snapshot().inFlight).toBe(1);

    const stream = pipeline.interceptor.intercept(ctx, handlerOf(() => pending.asObservable()));
    const settled = lastValueFrom(stream, { defaultValue: undefined });

    res.abort();
    expect(pipeline.service.snapshot().inFlight).toBe(0);

    pending.complete();
    await settled;
    expect(pipeline.service.snapshot().inFlight).toBe(0);
    expect(pipeline.releaseSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps one request's slot when a sibling request of the same org is rejected", async () => {
    const pipeline = makePipeline("ordinary-write");
    const longRes = new FakeResponse();
    const { ctx: longCtx } = makeContext("org-shared", longRes);
    const pending = new Subject<unknown>();

    pipeline.guard.canActivate(longCtx);
    const longStream = pipeline.interceptor.intercept(
      longCtx,
      handlerOf(() => pending.asObservable()),
    );
    const longSettled = lastValueFrom(longStream, { defaultValue: undefined });

    await runRequest({
      pipeline,
      orgId: "org-shared",
      downstreamGuards: [
        () => {
          throw new ForbiddenException("permission denied");
        },
      ],
    });

    expect(pipeline.service.snapshot().inFlight).toBe(1);

    pending.complete();
    await longSettled;
    longRes.finish();
    expect(pipeline.service.snapshot().inFlight).toBe(0);
    expect(pipeline.releaseSpy).toHaveBeenCalledTimes(2);
  });

  it("takes no slot to release when AdmissionGuard itself refuses with 503", async () => {
    const pipeline = makePipeline("ordinary-write", {
      ...BASE_CONFIG,
      maxConcurrent: 1,
      reservedFraction: 0,
    });
    pipeline.service.tryAdmit("ordinary-write", "org-fill");
    const before = pipeline.service.snapshot().inFlight;

    const res = new FakeResponse();
    const { ctx } = makeContext("org-refused", res);
    expect(() => pipeline.guard.canActivate(ctx)).toThrow(ServiceUnavailableException);
    res.finish();

    expect(pipeline.service.snapshot().inFlight).toBe(before);
    expect(pipeline.releaseSpy).not.toHaveBeenCalled();
  });

  it("releases nothing for a non-HTTP execution context", async () => {
    const pipeline = makePipeline("ordinary-write");
    const res = new FakeResponse();
    const { ctx, req } = makeContext("org-rpc", res, "rpc");

    expect(pipeline.guard.canActivate(ctx)).toBe(true);
    expect(req["_admissionOrgId"]).toBeUndefined();
    await lastValueFrom(pipeline.interceptor.intercept(ctx, handlerOf(() => of("ok"))));
    res.finish();

    expect(pipeline.service.snapshot().inFlight).toBe(0);
    expect(pipeline.releaseSpy).not.toHaveBeenCalled();
  });

  it("releases nothing for an HTTP request that never took a slot", async () => {
    const pipeline = makePipeline("ordinary-write");
    const res = new FakeResponse();
    const { ctx } = makeContext("org-untouched", res);

    await lastValueFrom(pipeline.interceptor.intercept(ctx, handlerOf(() => of("ok"))));
    res.finish();

    expect(pipeline.service.snapshot().inFlight).toBe(0);
    expect(pipeline.releaseSpy).not.toHaveBeenCalled();
  });
});
