import { createStreamAbortSignal } from "./ai-stream-abort";

interface Emitter {
  on(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
  emitClose(): void;
  listenerCount(): number;
}

function makeEmitter(): Emitter {
  const listeners = new Set<() => void>();
  return {
    on: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
    emitClose: () => {
      for (const l of [...listeners]) l();
    },
    listenerCount: () => listeners.size,
  };
}

/**
 * Express drains the body before a handler runs, so on a perfectly healthy
 * request `req` is already `complete` and emits `close`. A fake that only
 * exposes `on`/`off` cannot tell that apart from a hang-up, which is how the
 * previous version of this file passed while cancelling every AI call.
 */
function makeRequest(complete: boolean): Emitter & { complete: boolean } {
  return Object.assign(makeEmitter(), { complete });
}

function makeResponse(writableEnded: boolean): Emitter & { writableEnded: boolean } {
  return Object.assign(makeEmitter(), { writableEnded });
}

describe("createStreamAbortSignal", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("does NOT abort when the request stream closes because its body was fully received", () => {
    const req = makeRequest(true);
    const res = makeResponse(false);

    const handle = createStreamAbortSignal(req, res, 60_000);
    req.emitClose();

    expect(handle.signal.aborted).toBe(false);
    expect(handle.reason()).toBeNull();
  });

  it("aborts when the connection is torn down before the request finished arriving", () => {
    const req = makeRequest(false);
    const res = makeResponse(false);

    const handle = createStreamAbortSignal(req, res, 60_000);
    req.emitClose();

    expect(handle.signal.aborted).toBe(true);
    expect(handle.reason()).toBe("client_disconnected");
  });

  it("aborts when the client hangs up mid-answer — the response closes unfinished", () => {
    const req = makeRequest(true);
    const res = makeResponse(false);

    const handle = createStreamAbortSignal(req, res, 60_000);
    res.emitClose();

    expect(handle.signal.aborted).toBe(true);
    expect(handle.reason()).toBe("client_disconnected");
  });

  it("does NOT abort on the close a completed response also emits", () => {
    const req = makeRequest(true);
    const res = makeResponse(true);

    const handle = createStreamAbortSignal(req, res, 60_000);
    res.emitClose();
    req.emitClose();

    expect(handle.signal.aborted).toBe(false);
    expect(handle.reason()).toBeNull();
  });

  it("watches the response, not only the request, because the request is already closed by then", () => {
    const req = makeRequest(true);
    const res = makeResponse(false);

    createStreamAbortSignal(req, res, 60_000);

    expect(res.listenerCount()).toBe(1);
  });

  it("aborts at the deadline so a hung provider cannot hold the request open", () => {
    const handle = createStreamAbortSignal(makeRequest(true), makeResponse(false), 60_000);

    jest.advanceTimersByTime(59_999);
    expect(handle.signal.aborted).toBe(false);

    jest.advanceTimersByTime(2);
    expect(handle.signal.aborted).toBe(true);
    expect(handle.reason()).toBe("deadline_exceeded");
  });

  it("keeps the first reason when both arms fire", () => {
    const res = makeResponse(false);
    const handle = createStreamAbortSignal(makeRequest(true), res, 60_000);

    res.emitClose();
    jest.advanceTimersByTime(120_000);

    expect(handle.reason()).toBe("client_disconnected");
  });

  it("dispose clears the deadline timer and unsubscribes both streams", () => {
    const req = makeRequest(true);
    const res = makeResponse(false);
    const handle = createStreamAbortSignal(req, res, 60_000);

    expect(req.listenerCount()).toBe(1);
    expect(res.listenerCount()).toBe(1);
    handle.dispose();

    expect(req.listenerCount()).toBe(0);
    expect(res.listenerCount()).toBe(0);
    jest.advanceTimersByTime(120_000);
    expect(handle.signal.aborted).toBe(false);
  });

  it("dispose is idempotent", () => {
    const req = makeRequest(true);
    const res = makeResponse(false);
    const handle = createStreamAbortSignal(req, res, 60_000);

    handle.dispose();
    handle.dispose();

    expect(req.listenerCount()).toBe(0);
    expect(res.listenerCount()).toBe(0);
  });
});
