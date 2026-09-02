export type StreamAbortReason = "client_disconnected" | "deadline_exceeded";

export interface CloseableRequest {
  on(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

export interface EndableResponse {
  readonly writableEnded: boolean;
}

export interface StreamAbortHandle {
  readonly signal: AbortSignal;
  reason(): StreamAbortReason | null;
  dispose(): void;
}

/**
 * A client disconnect and a wall-clock deadline both have to reach the provider,
 * and `res.on("close")` also fires on a *successful* response — so the disconnect
 * arm is gated on `writableEnded` the same way `TenantContextInterceptor` gates it.
 */
export function createStreamAbortSignal(
  req: CloseableRequest,
  res: EndableResponse,
  deadlineMs: number,
): StreamAbortHandle {
  const controller = new AbortController();
  let reason: StreamAbortReason | null = null;
  let disposed = false;

  const abortWith = (next: StreamAbortReason): void => {
    if (controller.signal.aborted) return;
    reason = next;
    controller.abort();
  };

  const onClose = (): void => {
    if (!res.writableEnded) abortWith("client_disconnected");
  };

  req.on("close", onClose);

  const timer = setTimeout(() => abortWith("deadline_exceeded"), deadlineMs);
  timer.unref();

  return {
    signal: controller.signal,
    reason: () => reason,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      req.off("close", onClose);
    },
  };
}
