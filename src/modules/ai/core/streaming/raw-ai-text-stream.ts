import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function pipeRawAiTextStream(
  textStream: ReadableStream<string>,
  response: ServerResponse,
  init?: { headers?: Record<string, string> },
): Promise<void> {
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.setHeader("cache-control", "no-store, no-transform");
  response.setHeader("x-accel-buffering", "no");
  for (const [name, value] of Object.entries(init?.headers ?? {})) response.setHeader(name, value);
  async function* readOutput() {
    const reader = textStream.getReader();
    let completed = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          completed = true;
          return;
        }
        yield value;
      }
    } finally {
      try {
        if (!completed) await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  }
  await pipeline(Readable.from(readOutput()), response);
}

export function createPipeableAiTextStream(textStream: ReadableStream<string>) {
  return {
    textStream,
    pipeTextStreamToResponse: (response: ServerResponse, init?: { headers?: Record<string, string> }) =>
      pipeRawAiTextStream(textStream, response, init),
  };
}
