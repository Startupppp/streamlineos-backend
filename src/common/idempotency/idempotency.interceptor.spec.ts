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
import { IDEMPOTENCY_OPTIONAL } from "./idempotency.constants";
import {
  InMemoryCommandFenceStore,
  type ClaimParams,
  type ClaimResult,
  type CommandFenceStore,
} from "./command-fence-store";

const COMMAND = "portal.createGrant";
const BODY = { partyContactId: "c1" };

/**
 * Deliberately the *pre-params* hash format: `{ commandName, body }`, with no
 * `params` member at all.
 *
 * When the fence learned to hash route params, an empty params object was
 * omitted from the canonical form rather than serialised as `{}` — so a route
 * with no params keeps hashing exactly this string. That is what stops the
 * change from invalidating every live fence on the 83 param-free fenced routes
 * at deploy. It is asserted rather than described, in "hashes a param-free
 * route exactly as it did before params counted" below.
 */
const MATCHING_HASH = createHash("sha256")
  .update(JSON.stringify({ commandName: COMMAND, body: BODY }))
  .digest("hex");

/**
 * A store double. `claimResult` is either a fixed answer or a function of the
 * claim, so a case can answer the way the real store would for the hash the
 * interceptor actually computed: `claims` records exactly what the interceptor
 * handed the store, which is where a test that cares about the stored
 * `requestHash` must read it from — a hand-written hash is one the code under
 * test may never produce.
 */
function makeStore(claimResult: ClaimResult | ((params: ClaimParams) => ClaimResult)): {
  store: CommandFenceStore;
  claims: ClaimParams[];
  completeCalls: unknown[];
  failCalls: number[];
} {
  const claims: ClaimParams[] = [];
  const completeCalls: unknown[] = [];
  const failCalls: number[] = [];
  const store: CommandFenceStore = {
    claim: jest.fn((params: ClaimParams) => {
      claims.push(params);
      return Promise.resolve(
        typeof claimResult === "function" ? claimResult(params) : claimResult,
      );
    }),
    complete: jest
      .fn()
      .mockImplementation((_orgId: string, _id: number, _status: number, _data: unknown) => {
        completeCalls.push(_data);
        return Promise.resolve();
      }),
    fail: jest.fn().mockImplementation((_orgId: string, _id: number) => {
      failCalls.push(_id);
      return Promise.resolve();
    }),
  };
  return { store, claims, completeCalls, failCalls };
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
    const { store, claims } = makeStore({ kind: "proceed", fenceId: 9 });
    const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND, true), store);
    const handler = makeHandler("ok");

    const result$ = await interceptor.intercept(makeCtx(makeReq(), { statusCode: 201 }), handler);

    expect(await firstValueFrom(result$)).toBe("ok");
    expect(handler.handle).toHaveBeenCalled();
    expect(claims).toHaveLength(1);
    expect(store.complete).toHaveBeenCalledWith("org1", 9, 201, "ok");
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
    /* The org travels with the completion: the fence row is tenant-scoped under RLS. */
    expect(store.complete).toHaveBeenCalledWith("org1", 7, 201, { created: true });
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
    expect(store.fail).toHaveBeenCalledWith("org1", 11);
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
     * passed with the params removed from `hashRequest` again, because a
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
      const stored = createHash("sha256")
        .update(
          JSON.stringify({
            commandName: COMMAND,
            params: { candidateId: "1", offerId: "5" },
            body: BODY,
          }),
        )
        .digest("hex");
      /* Answer as the real store does: replay on the stored hash, 422 on any other. */
      const { store } = makeStore((params) =>
        params.requestHash === stored
          ? { kind: "replay", responseBody: { ok: true }, responseStatus: 200 }
          : { kind: "mismatch" },
      );
      const interceptor = new IdempotencyInterceptor(makeReflector(COMMAND), store);

      const result$ = await interceptor.intercept(
        makeCtx(
          makeReq({ params: { offerId: "5", candidateId: "1" } }),
          { statusCode: 200, status: jest.fn() },
        ),
        makeHandler("SHOULD_NOT_RUN"),
      );

      expect(await firstValueFrom(result$)).toEqual({ ok: true });
    });

    /**
     * The deploy-compatibility property, asserted directly rather than left to
     * `MATCHING_HASH` proving it as a side effect.
     *
     * A param-free route must hash byte-identically to the pre-params format,
     * or this change silently 422s every in-flight retry on 83 fenced routes
     * the moment it ships. `{}` is omitted from the canonical form, so it does.
     */
    it("hashes a param-free route exactly as it did before params counted", async () => {
      const { store } = makeStore((params) =>
        params.requestHash === MATCHING_HASH
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
