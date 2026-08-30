import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createHash } from "node:crypto";
import { firstValueFrom, of, throwError } from "rxjs";
import { IdempotencyInterceptor } from "./idempotency.interceptor";
import type { ClaimResult, CommandFenceStore } from "./command-fence-store";

const COMMAND = "portal.createGrant";
const BODY = { partyContactId: "c1" };
const MATCHING_HASH = createHash("sha256")
  .update(JSON.stringify({ commandName: COMMAND, body: BODY }))
  .digest("hex");

function makeStore(claimResult: ClaimResult): { store: CommandFenceStore; completeCalls: unknown[]; failCalls: number[] } {
  const completeCalls: unknown[] = [];
  const failCalls: number[] = [];
  const store: CommandFenceStore = {
    claim: jest.fn().mockResolvedValue(claimResult),
    complete: jest.fn().mockImplementation((_id: number, _status: number, _data: unknown) => {
      completeCalls.push(_data);
      return Promise.resolve();
    }),
    fail: jest.fn().mockImplementation((_id: number) => {
      failCalls.push(_id);
      return Promise.resolve();
    }),
  };
  return { store, completeCalls, failCalls };
}

function makeReflector(commandName: string | undefined): Reflector {
  return {
    getAllAndOverride: jest.fn().mockReturnValue(commandName),
  } as unknown as Reflector;
}

function makeCtx(req: unknown, res: unknown): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    headers: { "idempotency-key": "key-1" },
    body: BODY,
    user: { orgId: "org1", userId: "u1", sessionId: "sess-1" },
    ...overrides,
  };
}

function makeHandler(value: unknown): CallHandler {
  return { handle: jest.fn().mockReturnValue(of(value)) };
}

describe("IdempotencyInterceptor", () => {
  it("passes through when the handler is not decorated", async () => {
    const { store } = makeStore({ kind: "proceed", fenceId: 1 });
    const interceptor = new IdempotencyInterceptor(makeReflector(undefined), store);
    const handler = makeHandler("ok");
    const result$ = await interceptor.intercept(makeCtx(makeReq(), {}), handler);
    expect(await firstValueFrom(result$)).toBe("ok");
    expect(handler.handle).toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
  });

  it("requires an Idempotency-Key header", async () => {
    const { store } = makeStore({ kind: "proceed", fenceId: 1 });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), store);
    const req = makeReq({ headers: {} });
    await expect(
      interceptor.intercept(makeCtx(req, {}), makeHandler("ok")),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(store.claim).not.toHaveBeenCalled();
  });

  it("skips the fence when there is no tenant context", async () => {
    const { store } = makeStore({ kind: "proceed", fenceId: 1 });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), store);
    const req = makeReq({ user: { userId: "u1", sessionId: "s" } });
    const handler = makeHandler("ok");
    const result$ = await interceptor.intercept(makeCtx(req, {}), handler);
    expect(await firstValueFrom(result$)).toBe("ok");
    expect(handler.handle).toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
  });

  it("executes a fresh command and marks the fence completed", async () => {
    const { store, completeCalls } = makeStore({ kind: "proceed", fenceId: 7 });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), store);
    const handler = makeHandler({ created: true });
    const res = { statusCode: 201, status: jest.fn() };
    const result$ = await interceptor.intercept(makeCtx(makeReq(), res), handler);
    expect(await firstValueFrom(result$)).toEqual({ created: true });
    await Promise.resolve();
    expect(handler.handle).toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalledWith(7, 201, { created: true });
    expect(completeCalls).toHaveLength(1);
  });

  it("replays the stored response for a completed duplicate", async () => {
    const { store } = makeStore({
      kind: "replay",
      responseBody: { created: true },
      responseStatus: 201,
    });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), store);
    const handler = makeHandler({ created: "SHOULD_NOT_RUN" });
    const res = { statusCode: 200, status: jest.fn() };
    const result$ = await interceptor.intercept(makeCtx(makeReq(), res), handler);
    expect(await firstValueFrom(result$)).toEqual({ created: true });
    expect(handler.handle).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("rejects an in-flight duplicate with 409", async () => {
    const { store } = makeStore({ kind: "inflight" });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), store);
    await expect(
      interceptor.intercept(makeCtx(makeReq(), {}), makeHandler("x")),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects a reused key with a different body with 422", async () => {
    const { store } = makeStore({ kind: "mismatch" });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), store);
    await expect(
      interceptor.intercept(makeCtx(makeReq(), {}), makeHandler("x")),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("marks the fence FAILED when the handler errors", async () => {
    const { store, failCalls } = makeStore({ kind: "proceed", fenceId: 11 });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), store);
    const errorHandler: CallHandler = { handle: () => throwError(() => new Error("pipe-validation-error")) };
    const result$ = await interceptor.intercept(makeCtx(makeReq(), {}), errorHandler);
    await firstValueFrom(result$).catch(() => undefined);
    await Promise.resolve();
    expect(store.fail).toHaveBeenCalledWith(11);
    expect(failCalls).toHaveLength(1);
  });

  it("reclaims a FAILED fence with a different body hash (retry after validation failure succeeds)", async () => {
    const { store } = makeStore({ kind: "proceed", fenceId: 10 });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), store);
    const handler = makeHandler({ created: true });
    const result$ = await interceptor.intercept(makeCtx(makeReq(), {}), handler);
    expect(await firstValueFrom(result$)).toEqual({ created: true });
    expect(handler.handle).toHaveBeenCalled();
    expect(store.claim).toHaveBeenCalled();
  });

  it("still rejects a hash mismatch on a COMPLETED fence", async () => {
    const { store } = makeStore({ kind: "mismatch" });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), store);
    await expect(
      interceptor.intercept(makeCtx(makeReq(), {}), makeHandler("x")),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("propagates store errors (fail-closed: no catch wrapper)", async () => {
    const store: CommandFenceStore = {
      claim: jest.fn().mockRejectedValue(new Error("db exploded")),
      complete: jest.fn(),
      fail: jest.fn(),
    };
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), store);
    await expect(
      interceptor.intercept(makeCtx(makeReq(), {}), makeHandler("x")),
    ).rejects.toThrow("db exploded");
  });
});
