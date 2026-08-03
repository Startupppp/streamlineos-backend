import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createHash } from "node:crypto";
import { firstValueFrom, of } from "rxjs";
import { IdempotencyInterceptor } from "./idempotency.interceptor";
import type { Db } from "../../db/drizzle.module";

const COMMAND = "portal.createGrant";
const BODY = { partyContactId: "c1" };
const MATCHING_HASH = createHash("sha256")
  .update(JSON.stringify({ commandName: COMMAND, body: BODY }))
  .digest("hex");

interface DbMockOptions {
  insertReturning?: Array<{ fenceId: number }>;
  selectResult?: Record<string, unknown>[];
  updateReturning?: Array<{ fenceId: number }>;
}

function makeDb(opts: DbMockOptions) {
  const setCalls: Record<string, unknown>[] = [];
  const db = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve(opts.insertReturning ?? []),
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(opts.selectResult ?? []),
        }),
      }),
    }),
    update: () => ({
      set: (vals: Record<string, unknown>) => {
        setCalls.push(vals);
        const whereResult: Promise<undefined> & {
          returning?: () => Promise<Array<{ fenceId: number }>>;
        } = Promise.resolve(undefined);
        whereResult.returning = () => Promise.resolve(opts.updateReturning ?? []);
        return { where: () => whereResult };
      },
    }),
  };
  return { db: db as unknown as Db, setCalls };
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
    const { db } = makeDb({});
    const interceptor = new IdempotencyInterceptor(makeReflector(undefined), db);
    const handler = makeHandler("ok");
    const result$ = await interceptor.intercept(makeCtx(makeReq(), {}), handler);
    expect(await firstValueFrom(result$)).toBe("ok");
    expect(handler.handle).toHaveBeenCalled();
  });

  it("requires an Idempotency-Key header", async () => {
    const { db } = makeDb({});
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), db);
    const req = makeReq({ headers: {} });
    await expect(
      interceptor.intercept(makeCtx(req, {}), makeHandler("ok")),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("skips the fence when there is no tenant context", async () => {
    const { db } = makeDb({});
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), db);
    const req = makeReq({ user: { userId: "u1", sessionId: "s" } });
    const handler = makeHandler("ok");
    const result$ = await interceptor.intercept(makeCtx(req, {}), handler);
    expect(await firstValueFrom(result$)).toBe("ok");
    expect(handler.handle).toHaveBeenCalled();
  });

  it("executes a fresh command and marks the fence completed", async () => {
    const { db, setCalls } = makeDb({ insertReturning: [{ fenceId: 7 }] });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), db);
    const handler = makeHandler({ created: true });
    const res = { statusCode: 201, status: jest.fn() };
    const result$ = await interceptor.intercept(makeCtx(makeReq(), res), handler);
    expect(await firstValueFrom(result$)).toEqual({ created: true });
    await Promise.resolve();
    expect(handler.handle).toHaveBeenCalled();
    expect(setCalls.some((c) => c.status === "COMPLETED")).toBe(true);
  });

  it("replays the stored response for a completed duplicate", async () => {
    const { db } = makeDb({
      insertReturning: [],
      selectResult: [
        {
          commandFenceId: 7,
          requestHash: MATCHING_HASH,
          status: "COMPLETED",
          responseBody: { created: true },
          responseStatus: 201,
          leaseExpiresAt: new Date(),
        },
      ],
    });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), db);
    const handler = makeHandler({ created: "SHOULD_NOT_RUN" });
    const res = { statusCode: 200, status: jest.fn() };
    const result$ = await interceptor.intercept(makeCtx(makeReq(), res), handler);
    expect(await firstValueFrom(result$)).toEqual({ created: true });
    expect(handler.handle).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("rejects an in-flight duplicate with 409", async () => {
    const { db } = makeDb({
      insertReturning: [],
      selectResult: [
        {
          commandFenceId: 7,
          requestHash: MATCHING_HASH,
          status: "IN_FLIGHT",
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      ],
    });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), db);
    await expect(
      interceptor.intercept(makeCtx(makeReq(), {}), makeHandler("x")),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects a reused key with a different body with 422", async () => {
    const { db } = makeDb({
      insertReturning: [],
      selectResult: [
        {
          commandFenceId: 7,
          requestHash: "a-different-hash",
          status: "COMPLETED",
          leaseExpiresAt: new Date(),
        },
      ],
    });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), db);
    await expect(
      interceptor.intercept(makeCtx(makeReq(), {}), makeHandler("x")),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
