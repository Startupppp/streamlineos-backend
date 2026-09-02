import type { Request, Response } from "express";
import { createStreamAbortSignal } from "../../../../common/http/stream-abort";
import {
  encodeStreamSourcesHeader,
  pipeAiTextStream,
  rethrowStreamRouteError,
  type PipeableAiTextStream,
} from "./ai-stream-response";

export const AI_TEXT_STREAM_DEADLINE_MS = 60_000;

export interface AiTextStreamRouteOptions {
  feature: string;
  orgId: string;
  route: string;
  deadlineMs?: number;
  /**
   * Header name the producer's `sources` are published under, URL-encoded JSON.
   * Citations must reach the client BEFORE the body or a stream the user stops
   * halfway loses them, and a trailer is not a place a fetch reader can see.
   */
  sourcesHeader?: string;
}

export interface AiTextStreamProduct {
  stream: PipeableAiTextStream;
  sources?: readonly unknown[];
}

function sourceHeaders(
  options: AiTextStreamRouteOptions,
  sources: readonly unknown[] | undefined,
): Record<string, string> | undefined {
  if (options.sourcesHeader === undefined || sources === undefined) return undefined;
  const encoded = encodeStreamSourcesHeader(sources);
  if (encoded === null) return undefined;
  return {
    [options.sourcesHeader]: encoded,
    "access-control-expose-headers": options.sourcesHeader,
  };
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
  produce: (signal: AbortSignal) => Promise<AiTextStreamProduct>,
): Promise<void> {
  const abort = createStreamAbortSignal(
    req,
    res,
    options.deadlineMs ?? AI_TEXT_STREAM_DEADLINE_MS,
  );

  try {
    const { stream, sources } = await produce(abort.signal);
    const headers = sourceHeaders(options, sources);
    await pipeAiTextStream(res, stream, {
      feature: options.feature,
      orgId: options.orgId,
      ...(headers !== undefined ? { headers } : {}),
    });
  } catch (error) {
    rethrowStreamRouteError(error, { route: options.route });
  } finally {
    abort.dispose();
  }
}
