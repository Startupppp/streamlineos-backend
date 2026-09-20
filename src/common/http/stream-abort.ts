export type StreamAbortReason = "client_disconnected" | "deadline_exceeded";

export interface CloseableRequest {
  on(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
  /**
   * Node sets this once the body has been fully received. The `close` event is
   * emitted in that case too, so it is the only thing that separates "the client
   * finished sending" from "the connection died".
   */
  readonly complete?: boolean;
}

export interface EndableResponse {
  readonly writableEnded: boolean;
  on(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

export interface BackpressuredResponse {
  readonly destroyed: boolean;
  write(chunk: string | Uint8Array): boolean;
  once(event: "drain" | "close" | "error", listener: () => void): unknown;
  off(event: "drain" | "close" | "error", listener: () => void): unknown;
}

export async function writeChunk(
  res: BackpressuredResponse,
  chunk: string | Uint8Array,
): Promise<boolean> {
  if (res.destroyed) return false;
  if (res.write(chunk)) return true;

  return new Promise<boolean>((resolve) => {
    function cleanup(): void {
      res.off("drain", onDrain);
      res.off("close", onEnd);
      res.off("error", onEnd);
    }
    function onDrain(): void {
      cleanup();
      resolve(true);
    }
    function onEnd(): void {
      cleanup();
      resolve(false);
    }
    res.once("drain", onDrain);
    res.once("close", onEnd);
    res.once("error", onEnd);
  });
}

export interface StreamAbortHandle {
  readonly signal: AbortSignal;
  reason(): StreamAbortReason | null;
  dispose(): void;
}

/**
 * The request stream is the wrong place to watch for a hang-up. Express drains
 * the body before the handler runs, so `req` is already `complete` and
 * `destroyed`: a listener attached early fires immediately on a perfectly
 * healthy request, and one attached late never fires at all — which is what a
 * real disconnect then looks like. The response is what stays open for the
 * length of the call, so `res.close` before `writableEnded` is the arm that
 * actually detects the client leaving; the request arm is kept only for the
 * premature-termination case Node marks with `complete === false`.
 */
export function createStreamAbortSignal(
  req: CloseableRequest,
  res: EndableResponse,
  deadlineMs: number | null,
): StreamAbortHandle {
  const controller = new AbortController();
  let reason: StreamAbortReason | null = null;
  let disposed = false;

  const abortWith = (next: StreamAbortReason): void => {
    if (controller.signal.aborted) return;
    reason = next;
    controller.abort();
  };

  const onRequestClose = (): void => {
    if (req.complete === true) return;
    if (!res.writableEnded) abortWith("client_disconnected");
  };

  const onResponseClose = (): void => {
    if (!res.writableEnded) abortWith("client_disconnected");
  };

  req.on("close", onRequestClose);
  res.on("close", onResponseClose);

  const timer =
    deadlineMs === null
      ? null
      : setTimeout(() => abortWith("deadline_exceeded"), deadlineMs);
  timer?.unref();

  return {
    signal: controller.signal,
    reason: () => reason,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      req.off("close", onRequestClose);
      res.off("close", onResponseClose);
    },
  };
}
