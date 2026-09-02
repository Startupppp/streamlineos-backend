import { HttpException, InternalServerErrorException } from "@nestjs/common";
import type { ServerResponse } from "http";
import { logger } from "../../../../common/logger/logger.service";

export interface PipeableAiTextStream {
  pipeTextStreamToResponse(
    response: ServerResponse,
    init?: { headers?: Record<string, string> },
  ): Promise<void>;
}

export interface AiStreamPipeOptions {
  feature: string;
  orgId: string;
  headers?: Record<string, string>;
  onFault?: (error: unknown) => void;
}

/**
 * `pipeTextStreamToResponse` returns a promise that rejects on a mid-stream
 * provider fault; dropped, that is an unhandled rejection and the client is left
 * with a truncated 200. Headers are already on the wire by then, so the only
 * honest close is to end the response and record the fault.
 */
export async function pipeAiTextStream(
  res: ServerResponse,
  stream: PipeableAiTextStream,
  options: AiStreamPipeOptions,
): Promise<void> {
  try {
    await stream.pipeTextStreamToResponse(
      res,
      options.headers ? { headers: options.headers } : undefined,
    );
  } catch (error) {
    options.onFault?.(error);
    logger.error("AI stream terminated before completion", {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      feature: options.feature,
      orgId: options.orgId,
    });
    if (!res.writableEnded) res.end();
  }
}

/**
 * A blanket `catch` that rewraps everything erases the breaker's 503 and the
 * credit ledger's 402 into a 500, so the client cannot tell "back off" from
 * "top up" from "we broke".
 */
export function rethrowStreamRouteError(
  error: unknown,
  context: { route: string },
): never {
  if (error instanceof HttpException) throw error;
  logger.error("AI stream route error", {
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    route: context.route,
  });
  throw new InternalServerErrorException("Internal server error");
}

const MAX_SOURCE_HEADER_BYTES = 4_096;

/**
 * Citations must survive a stream that is later truncated, so they go out with
 * the headers rather than as a trailer the client may never receive.
 */
export function encodeStreamSourcesHeader(sources: readonly unknown[]): string | null {
  if (sources.length === 0) return null;
  for (let count = sources.length; count > 0; count -= 1) {
    const encoded = encodeURIComponent(JSON.stringify(sources.slice(0, count)));
    if (Buffer.byteLength(encoded, "utf8") <= MAX_SOURCE_HEADER_BYTES) return encoded;
  }
  return null;
}
