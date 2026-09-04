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
 * with a truncated 200.
 *
 * The status line is already on the wire by then, so the fault cannot be
 * expressed as a status code — but it MUST still be expressed. Ending the
 * response cleanly (`res.end()`, which is what this did) sends the terminating
 * zero-length chunk, so the client's read loop sees an ordinary `done`: the
 * frontend returned `{ status: "completed", text: <partial> }`, rendered a
 * half-sentence as the finished draft, and offered an Apply button for it. An
 * error surfaced as a successful state, which none of the nine AI failure
 * states can fire on because the transport reported success.
 *
 * `res.destroy()` is the mechanism HTTP already has for this: the chunked body
 * ends without its terminator, so `fetch`'s reader rejects instead of
 * completing, `classifyAiError` puts the surface into a real failure state with
 * a retry, and a non-browser client (curl, a mobile app, a proxy) sees the same
 * truncation. It needs no wire-format change, so all 26 `respondWithAiTextStream`
 * routes and both client tests keep their contract. A sentinel token in the body
 * was the alternative and is worse twice over: `onToken` has already painted it
 * on screen before the reader could strip it, and "a string the model cannot
 * emit" is not a property anything enforces.
 *
 * A response the failed pipe already ended is left alone — the client has its
 * terminator and there is nothing left to signal.
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
    // No argument: `destroy(err)` would emit 'error' on the response, and an
    // unhandled 'error' on a Writable takes the process down.
    if (!res.writableEnded) res.destroy();
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
const MAX_SOURCE_FIELD_CHARS = 160;

/** The companion header naming how many citations did not fit. */
export function sourcesTruncatedHeaderName(sourcesHeader: string): string {
  return `${sourcesHeader}-truncated`;
}

export interface EncodedStreamSources {
  /** URL-encoded JSON of the sources that fit. */
  readonly encoded: string;
  readonly included: number;
  /** How many citations the header could not carry. Zero means complete. */
  readonly dropped: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A citation chip renders a title and a snippet, not an essay. Capping the
 * strings is what turns "one long source and the whole header is abandoned"
 * into "every source arrives, some of them elided" — the header budget is spent
 * on COUNT, which is what the reader needs to check the answer against.
 */
function capSourceFields(source: unknown): unknown {
  if (!isRecord(source)) return source;
  const capped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    capped[key] =
      typeof value === "string" && value.length > MAX_SOURCE_FIELD_CHARS
        ? `${value.slice(0, MAX_SOURCE_FIELD_CHARS - 1)}…`
        : value;
  }
  return capped;
}

/**
 * Citations must survive a stream that is later truncated, so they go out with
 * the headers rather than as a trailer the client may never receive.
 *
 * Loss is now REPORTED rather than silent. The old encoder walked the list
 * shortest-first and returned `null` the moment nothing fit, so a grounded
 * answer whose first source happened to carry a long title reached the client
 * with no sources at all and no way to know any had existed — the reader saw a
 * confident, apparently unsourced answer, which is precisely the state citation
 * integrity exists to prevent. String fields are capped first so a single verbose
 * source cannot evict the rest, and whatever still does not fit is counted and
 * returned to the caller, which publishes it on a companion header and logs it.
 */
export function encodeStreamSources(
  sources: readonly unknown[],
  context?: { feature: string; orgId: string },
): EncodedStreamSources | null {
  if (sources.length === 0) return null;

  const capped = sources.map(capSourceFields);

  for (let count = capped.length; count > 0; count -= 1) {
    const encoded = encodeURIComponent(JSON.stringify(capped.slice(0, count)));
    if (Buffer.byteLength(encoded, "utf8") > MAX_SOURCE_HEADER_BYTES) continue;

    const dropped = capped.length - count;
    if (dropped > 0)
      logger.warn("AI stream citations truncated to fit the header budget", {
        dropped,
        included: count,
        total: capped.length,
        ...(context ?? {}),
      });
    return { encoded, included: count, dropped };
  }

  logger.warn("AI stream citations could not be published at all", {
    dropped: capped.length,
    included: 0,
    total: capped.length,
    ...(context ?? {}),
  });
  return { encoded: encodeURIComponent("[]"), included: 0, dropped: capped.length };
}
