import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  InternalServerErrorException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createHash } from "node:crypto";
import { firstValueFrom, of, throwError } from "rxjs";
import { IdempotencyInterceptor } from "./idempotency.interceptor";
import { IDEMPOTENCY_OPTIONAL } from "./idempotency.constants";
import type { ClaimParams, ClaimResult, CommandFenceStore } from "./command-fence-store";
import { InMemoryCommandFenceStore } from "./command-fence-store-memory";

const COMMAND = "portal.createGrant";
const BODY = { partyContactId: "c1" };
/** The pre-widening hash, which the interceptor still emits as `legacyRequestHash`. */
const LEGACY_HASH = createHash("sha256")
  .update(JSON.stringify({ commandName: COMMAND, body: BODY }))
  .digest("hex");

/**
 * A store double. `claimResult` is either a fixed answer or a function of the
 * claim, so a case can answer the way the real store would for the hash the
 * interceptor actually computed: `claimParams` records exactly what the
 * interceptor handed the store, which is where a test that cares about the
 * stored `requestHash` must read it from — a hand-written hash is one the code
 * under test may never produce.
 */
function makeStore(claimResult: ClaimResult | ((params: ClaimParams) => ClaimResult)): {
  store: CommandFenceStore;
  completeCalls: unknown[];
  failCalls: number[];
  claimParams: ClaimParams[];
} {
  const completeCalls: unknown[] = [];
  const failCalls: number[] = [];
  const claimParams: ClaimParams[] = [];
  const store: CommandFenceStore = {
    claim: jest.fn((params: ClaimParams) => {
      claimParams.push(params);
      return Promise.resolve(
        typeof claimResult === "function" ? claimResult(params) : claimResult,
      );
    }),
    complete: jest
      .fn()
      .mockImplementation((_id: number, _status: number, _data: unknown, _orgId: string) => {
        completeCalls.push(_data);
        return Promise.resolve();
      }),
    fail: jest.fn().mockImplementation((_id: number, _orgId: string) => {
      failCalls.push(_id);
      return Promise.resolve();
    }),
  };
  return { store, completeCalls, failCalls, claimParams };
}

/**
 * Key-aware, not a blanket `mockReturnValue`.
 *
 * It used to answer the same value for every metadata key it was asked about,
 * which was harmless while `IDEMPOTENCY_COMMAND` was the only one. Once
 * `IDEMPOTENCY_OPTIONAL` existed, a blanket mock answered the command *name*
 * for it — a truthy string — and every fence in the suite silently became
 * optional, so "requires an Idempotency-Key header" would have passed by not
 * requiring it.
 */
function makeReflector(commandName: string | undefined, optional = false): Reflector {
  return {
    getAllAndOverride: jest.fn((key: string) =>
      key === IDEMPOTENCY_OPTIONAL ? optional : commandName,
    ),
  } as unknown as Reflector;
}

function makeCtx(req: unknown, res: unknown): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

/**
 * `params: {}` rather than an absent key, because that is what Express hands a
 * route with no path params — never `undefined`. The default here is the
 * param-free shape; a case that cares passes its own.
 */
function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    headers: { "idempotency-key": "key-1" },
    params: {},
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

  /**
   * TS-17. `@Idempotent(name, { required: false })`.
   *
   * The point of the option is that an endpoint can offer replay safety without
   * making every existing caller send a header they have never sent — a 400 on
   * a POST with a body reads like a validation failure and is hard to diagnose.
   * So: no key, no fence, no error.
   */
  it("passes through with no key when the fence is optional", async () => {
    const { store, completeCalls } = makeStore({ kind: "proceed", fenceId: 1 });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND, true), store);
    const handler = makeHandler("ok");

    const result$ = await interceptor.intercept(makeCtx(makeReq({ headers: {} }), {}), handler);

    expect(await firstValueFrom(result$)).toBe("ok");
    expect(handler.handle).toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(completeCalls).toHaveLength(0);
  });

  /**
   * And the other half: optional means the header may be absent, not that it is
   * ignored. A caller who sends one still gets the full contract.
   */
  it("still fences an optional command when a key is supplied", async () => {
    const { store, claimParams } = makeStore({ kind: "proceed", fenceId: 9 });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND, true), store);
    const handler = makeHandler("ok");

    const result$ = await interceptor.intercept(makeCtx(makeReq(), { statusCode: 201 }), handler);

    expect(await firstValueFrom(result$)).toBe("ok");
    expect(handler.handle).toHaveBeenCalled();
    expect(claimParams).toHaveLength(1);
    /* The org travels with the completion: the fence row is tenant-scoped under RLS. */
    expect(store.complete).toHaveBeenCalledWith(9, 201, "ok", "org1");
  });

  it("fails closed when a fenced command carries no organisation context", async () => {
    const { store } = makeStore({ kind: "proceed", fenceId: 1 });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), store);
    const req = makeReq({ user: { userId: "u1", sessionId: "s" } });
    const handler = makeHandler("ok");
    await expect(
      interceptor.intercept(makeCtx(req, {}), handler),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(handler.handle).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
  });

  it("hashes the path params, method and query, not only the body", async () => {
    const { store, claimParams } = makeStore({ kind: "proceed", fenceId: 1 });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), store);
    const a = makeReq({ method: "POST", params: { creditNoteId: "a" }, query: {} });
    const b = makeReq({ method: "POST", params: { creditNoteId: "b" }, query: {} });
    await firstValueFrom(await interceptor.intercept(makeCtx(a, {}), makeHandler("ok")));
    await firstValueFrom(await interceptor.intercept(makeCtx(b, {}), makeHandler("ok")));

    expect(claimParams).toHaveLength(2);
    expect(claimParams[0]?.requestHash).not.toBe(claimParams[1]?.requestHash);
    // The body is identical, so the pre-widening hash cannot tell them apart at all.
    expect(claimParams[0]?.legacyRequestHash).toBe(LEGACY_HASH);
    expect(claimParams[1]?.legacyRequestHash).toBe(LEGACY_HASH);
  });

  it("orders query and param keys, so ?a=1&b=2 and ?b=2&a=1 are one command", async () => {
    const { store, claimParams } = makeStore({ kind: "proceed", fenceId: 1 });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), store);
    const a = makeReq({ method: "POST", params: {}, query: { a: "1", b: "2" } });
    const b = makeReq({ method: "POST", params: {}, query: { b: "2", a: "1" } });
    await firstValueFrom(await interceptor.intercept(makeCtx(a, {}), makeHandler("ok")));
    await firstValueFrom(await interceptor.intercept(makeCtx(b, {}), makeHandler("ok")));
    expect(claimParams[0]?.requestHash).toBe(claimParams[1]?.requestHash);
    expect(store.claim).toHaveBeenCalledTimes(2);
  });

  it("executes a fresh command and marks the fence completed", async () => {
    const { store, completeCalls } = makeStore({ kind: "proceed", fenceId: 7 });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), store);
    const handler = makeHandler({ created: true });
    const res = { statusCode: 201, status: jest.fn() };
    const result$ = await interceptor.intercept(makeCtx(makeReq(), res), handler);
    expect(await firstValueFrom(result$)).toEqual({ created: true });
    expect(handler.handle).toHaveBeenCalled();
    /* The org travels with the completion: the fence row is tenant-scoped under RLS. */
    expect(store.complete).toHaveBeenCalledWith(7, 201, { created: true }, "org1");
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
    expect(store.fail).toHaveBeenCalledWith(11, "org1");
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

  /**
   * The route params are part of the command's identity.
   *
   * Without them the hash could not tell two resources apart, and on a route
   * with no body it could not tell them apart at all: every
   * `POST /timesheets/timer/:timerId/stop` hashed identically, so one key
   * reused across two timers replayed the first response and left the second
   * timer running. Sixty-nine fenced routes platform-wide were param-carrying
   * with no body and shared that shape — posting two AR invoices under one key
   * had the same failure. `idempotency-replay.spec.ts` pins it end-to-end on a
   * real controller; these cases pin the mechanism.
   */
  describe("route params in the request hash", () => {
    /**
     * The stored hash is the one the interceptor itself wrote for timer 11, not
     * a hash written by hand here.
     *
     * That distinction is the whole test. An earlier draft hardcoded the
     * params-inclusive hash as the stored value and asserted 422 — and it
     * passed with the params removed from the request hash again, because a
     * pre-fix interceptor computes a hash that does not match a hand-written
     * params-inclusive one either. It reported the fix working by way of a
     * mismatch it had manufactured itself. Claiming the fence for timer 11
     * first, through the real in-memory store, means the stored hash is
     * whatever the current implementation produces, so removing params makes
     * the two requests agree and this case fails, which is what it is for.
     */
    it("rejects a key reused against a different resource with 422", async () => {
      const store = new InMemoryCommandFenceStore();
      const claimSpy = jest.spyOn(store, "claim");
      const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), store);

      await firstValueFrom(
        await interceptor.intercept(
          makeCtx(makeReq({ params: { timerId: "11" } }), {
            statusCode: 200,
            status: jest.fn(),
          }),
          makeHandler({ stopped: 11 }),
        ),
      );
      const storedHash = claimSpy.mock.calls[0]?.[0].requestHash;
      expect(typeof storedHash).toBe("string");

      const handler = makeHandler("SHOULD_NOT_RUN");
      await expect(
        interceptor.intercept(
          makeCtx(makeReq({ params: { timerId: "22" } }), {}),
          handler,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(handler.handle).not.toHaveBeenCalled();
      expect(claimSpy.mock.calls[1]?.[0].requestHash).not.toBe(storedHash);
    });

    /**
     * Sorted, so the hash depends on the params rather than on the order the
     * route happens to spell them. `JSON.stringify` follows insertion order and
     * Express builds `req.params` in path order, so without the sort a route
     * rewritten as `/:offerId/candidates/:candidateId` would hash differently
     * from `/:candidateId/offers/:offerId` for the same pair of values —
     * invalidating live fences for a purely cosmetic change.
     */
    it("hashes params by name, not by the order they arrive in", async () => {
      /* Compared hash-to-hash, both computed by the interceptor, never against a hand-written one. */
      const { store, claimParams } = makeStore({ kind: "proceed", fenceId: 1 });
      const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), store);

      await firstValueFrom(
        await interceptor.intercept(
          makeCtx(makeReq({ params: { offerId: "5", candidateId: "1" } }), {}),
          makeHandler("ok"),
        ),
      );
      await firstValueFrom(
        await interceptor.intercept(
          makeCtx(makeReq({ params: { candidateId: "1", offerId: "5" } }), {}),
          makeHandler("ok"),
        ),
      );

      expect(claimParams).toHaveLength(2);
      expect(claimParams[0]?.requestHash).toBe(claimParams[1]?.requestHash);
    });

    /**
     * The deploy-compatibility property, asserted directly.
     *
     * Widening the hash rewrites its input, so a fence already on disk carries
     * the pre-widening `{ commandName, body }` hash; without a bridge every
     * in-flight retry across the deploy would 422. The bridge is
     * `legacyRequestHash`, which the store accepts only for a row written before
     * this process started (`requestHashMatches`). The double answers exactly as
     * the real store does for such a row: replay when the legacy hash matches.
     * `LEGACY_HASH` is hand-written on purpose — it is the on-disk format of
     * those old rows, which is the whole point.
     */
    it("replays a fence written before the hash widened, through legacyRequestHash", async () => {
      const { store } = makeStore((params) =>
        params.legacyRequestHash === LEGACY_HASH
          ? { kind: "replay", responseBody: { created: true }, responseStatus: 201 }
          : { kind: "mismatch" },
      );
      const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), store);
      const res = { statusCode: 200, status: jest.fn() };

      const result$ = await interceptor.intercept(
        makeCtx(makeReq({ params: {} }), res),
        makeHandler("SHOULD_NOT_RUN"),
      );

      expect(await firstValueFrom(result$)).toEqual({ created: true });
      expect(res.status).toHaveBeenCalledWith(201);
    });
  });
});
