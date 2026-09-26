import { HttpException, InternalServerErrorException } from "@nestjs/common";
import type { ServerResponse } from "http";
import {
  createUIMessageStream,
  pipeUIMessageStreamToResponse as sdkPipeUIMessageStreamToResponse,
} from "ai";
import type { UIMessageChunk } from "ai";
import { logger } from "../../../../common/logger/logger.service";
import { pipeRawAiTextStream } from "./raw-ai-text-stream";
import type { AskOsDirective } from "./ask-os-directive";
import { isRecord } from "../../../../common/types/is-record";

export interface PipeableAiTextStream {
  readonly textStream?: ReadableStream<string>;
  pipeTextStreamToResponse(
    response: ServerResponse,
    init?: { headers?: Record<string, string> },
  ): Promise<void>;
}

export interface PipeableAiUiStream {
  pipeUIMessageStreamToResponse(
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

export async function pipeAiTextStream(
  res: ServerResponse,
  stream: PipeableAiTextStream,
  options: AiStreamPipeOptions,
): Promise<void> {
  try {
    const init = options.headers ? { headers: options.headers } : undefined;
    const textStream = stream.textStream;
    if (textStream) await pipeRawAiTextStream(textStream, res, init);
    else await stream.pipeTextStreamToResponse(res, init);
  } catch (error) {
    options.onFault?.(error);
    logger.error("AI stream terminated before completion", {
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      feature: options.feature,
      orgId: options.orgId,
    });
    // No argument: `destroy(err)` would emit 'error' on the response, and an
    // unhandled 'error' on a Writable takes the process down.
    if (!res.writableEnded) res.destroy();
  }
}

export async function pipeAiUiMessageStream(
  res: ServerResponse,
  stream: PipeableAiUiStream,
  options: AiStreamPipeOptions,
): Promise<void> {
  try {
    await stream.pipeUIMessageStreamToResponse(
      res,
      options.headers ? { headers: options.headers } : undefined,
    );
  } catch (error) {
    options.onFault?.(error);
    logger.error("AI UI message stream terminated before completion", {
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      feature: options.feature,
      orgId: options.orgId,
    });
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
    error:
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    route: context.route,
  });
  throw new InternalServerErrorException("Internal server error");
}

export interface ModelStreamSource {
  toUIMessageStream(): ReadableStream<UIMessageChunk>;
}

export function buildAskOsDirectiveStream(
  modelStream: ModelStreamSource,
  directives: AskOsDirective[],
): ReadableStream<UIMessageChunk> {
  return createUIMessageStream({
    execute: async ({ writer }) => {
      const reader = modelStream.toUIMessageStream().getReader();
      let emitted = 0;
      const flushDirectives = (): void => {
        while (emitted < directives.length) {
          writer.write({
            type: "data-askos-directive",
            data: directives[emitted],
            transient: true,
          });
          emitted += 1;
        }
      };
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          writer.write(chunk.value);
          flushDirectives();
        }
      } finally {
        reader.releaseLock();
      }
      flushDirectives();
    },
  });
}

export function makeAskOsDirectivePipe(
  modelStream: ModelStreamSource,
  directives: AskOsDirective[],
): PipeableAiUiStream {
  return {
    pipeUIMessageStreamToResponse: async (res, init) => {
      await sdkPipeUIMessageStreamToResponse({
        response: res,
        stream: buildAskOsDirectiveStream(modelStream, directives),
        ...(init?.headers !== undefined ? { headers: init.headers } : {}),
      });
    },
  };
}

export function buildSourcesEventStream(
  modelStream: ModelStreamSource,
  eventType: `data-${string}`,
  sources: readonly unknown[],
): ReadableStream<UIMessageChunk> {
  return createUIMessageStream({
    execute: async ({ writer }) => {
      if (sources.length > 0) {
        writer.write({
          type: eventType,
          data: sources,
          transient: true,
        });
      }
      const reader = modelStream.toUIMessageStream().getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          writer.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    },
  });
}

export function makeSourcesEventPipe(
  modelStream: ModelStreamSource,
  eventType: `data-${string}`,
  sources: readonly unknown[],
): PipeableAiUiStream {
  return {
    pipeUIMessageStreamToResponse: async (res, init) =>
      sdkPipeUIMessageStreamToResponse({
        response: res,
        stream: buildSourcesEventStream(modelStream, eventType, sources),
        ...(init?.headers !== undefined ? { headers: init.headers } : {}),
      }),
  };
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
  return {
    encoded: encodeURIComponent("[]"),
    included: 0,
    dropped: capped.length,
  };
}
