import { createStreamAbortSignal } from "./ai-stream-abort";

interface FakeRequest {
  on(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
  emitClose(): void;
  listenerCount(): number;
}

function makeRequest(): FakeRequest {
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

describe("createStreamAbortSignal", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("aborts when the client disconnects before the response finished", () => {
    const req = makeRequest();
    const res = { writableEnded: false };

    const handle = createStreamAbortSignal(req, res, 60_000);
    req.emitClose();

    expect(handle.signal.aborted).toBe(true);
    expect(handle.reason()).toBe("client_disconnected");
  });

  it("does NOT abort on the close event a completed response also emits", () => {
    const req = makeRequest();
    const res = { writableEnded: true };

    const handle = createStreamAbortSignal(req, res, 60_000);
    req.emitClose();

    expect(handle.signal.aborted).toBe(false);
    expect(handle.reason()).toBeNull();
  });

  it("aborts at the deadline so a hung provider cannot hold the request open", () => {
    const req = makeRequest();
    const handle = createStreamAbortSignal(req, { writableEnded: false }, 60_000);

    jest.advanceTimersByTime(59_999);
    expect(handle.signal.aborted).toBe(false);

    jest.advanceTimersByTime(2);
    expect(handle.signal.aborted).toBe(true);
    expect(handle.reason()).toBe("deadline_exceeded");
  });

  it("keeps the first reason when both arms fire", () => {
    const req = makeRequest();
    const res = { writableEnded: false };
    const handle = createStreamAbortSignal(req, res, 60_000);

    req.emitClose();
    jest.advanceTimersByTime(120_000);

    expect(handle.reason()).toBe("client_disconnected");
  });

  it("dispose clears the deadline timer and unsubscribes, so a long-lived process accumulates neither", () => {
    const req = makeRequest();
    const res = { writableEnded: false };
    const handle = createStreamAbortSignal(req, res, 60_000);

    expect(req.listenerCount()).toBe(1);
    handle.dispose();

    expect(req.listenerCount()).toBe(0);
    jest.advanceTimersByTime(120_000);
    expect(handle.signal.aborted).toBe(false);
  });

  it("dispose is idempotent", () => {
    const req = makeRequest();
    const handle = createStreamAbortSignal(req, { writableEnded: false }, 60_000);

    handle.dispose();
    handle.dispose();

    expect(req.listenerCount()).toBe(0);
  });
});
