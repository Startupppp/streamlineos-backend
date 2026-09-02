import type { Request, Response } from "express";
import { createStreamAbortSignal } from "../../../../common/http/stream-abort";
import { pipeAiTextStream, rethrowStreamRouteError, type PipeableAiTextStream } from "./ai-stream-response";

export const AI_TEXT_STREAM_DEADLINE_MS = 60_000;

export interface AiTextStreamRouteOptions {
  feature: string;
  orgId: string;
  route: string;
  deadlineMs?: number;
}

/**
 * The whole streaming route shape in one place: a deadline and disconnect signal
 * the producer must honour, the pipe promise awaited (dropped, a mid-stream
 * fault is an unhandled rejection and the client gets a truncated 200), and an
 * `HttpException` passed through so the ledger's 402 and the breaker's 503 do
 * not flatten into an opaque 500.
 */
export async function respondWithAiTextStream(
  req: Request,
  res: Response,
  options: AiTextStreamRouteOptions,
  produce: (signal: AbortSignal) => Promise<{ stream: PipeableAiTextStream }>,
): Promise<void> {
  const abort = createStreamAbortSignal(
    req,
    res,
    options.deadlineMs ?? AI_TEXT_STREAM_DEADLINE_MS,
  );

  try {
    const { stream } = await produce(abort.signal);
    await pipeAiTextStream(res, stream, {
      feature: options.feature,
      orgId: options.orgId,
    });
  } catch (error) {
    rethrowStreamRouteError(error, { route: options.route });
  } finally {
    abort.dispose();
  }
}
