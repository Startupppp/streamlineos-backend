import type { AiTextStream } from "../gateway/ai-gateway-stream.helper";
import type { AiUsageMeta } from "../gateway/ai-gateway.types";
import {
  computeTokenCharge,
  milliToCredits,
} from "../billing/ai-model-pricing.constants";
import { createPipeableAiTextStream } from "./raw-ai-text-stream";

export const AI_RESULT_STREAM_CONTENT_TYPE = "application/x-ndjson";

export function createAiResultStream<T>(options: {
  generation: AiTextStream;
  signal: AbortSignal;
  complete: (text: string, aiUsage: AiUsageMeta) => Promise<T>;
}) {
  const { generation, signal, complete } = options;
  const encoded = generation.stream.textStream.pipeThrough(
    new TransformStream<string, string>({
      transform(text, controller) {
        signal.throwIfAborted();
        controller.enqueue(`${JSON.stringify({ type: "text", text })}\n`);
      },
      async flush(controller) {
        signal.throwIfAborted();
        const finishReason = await generation.stream.finishReason;
        if (finishReason !== "stop")
          throw new Error("AI generation did not complete");
        const [text, usage] = await Promise.all([
          generation.stream.text,
          generation.stream.totalUsage,
        ]);
        const promptTokens = usage.inputTokens ?? 0;
        const completionTokens = usage.outputTokens ?? 0;
        const { milliCredits, costUsd } = computeTokenCharge(
          generation.model,
          promptTokens,
          completionTokens,
        );
        const aiUsage: AiUsageMeta = {
          model: generation.model,
          promptTokens,
          completionTokens,
          totalTokens: usage.totalTokens ?? promptTokens + completionTokens,
          credits: milliToCredits(milliCredits),
          costUsd,
        };
        signal.throwIfAborted();
        const data = await complete(text, aiUsage);
        signal.throwIfAborted();
        controller.enqueue(`${JSON.stringify({ type: "result", data })}\n`);
      },
    }),
  );
  const reader = encoded.getReader();
  const textStream = new ReadableStream<string>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch {
        controller.enqueue(
          `${JSON.stringify({ type: "error", message: "AI generation could not be completed" })}\n`,
        );
        controller.close();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return { stream: createPipeableAiTextStream(textStream) };
}
