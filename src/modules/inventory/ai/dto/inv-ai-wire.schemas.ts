import { z } from "zod";

/**
 * The two envelopes every inventory AI answer carries, written once.
 *
 * `provenance` is `InvAiProvenance` (`inv-ai-contract.ts`) and `aiUsage` is
 * `AiUsageMeta` (`modules/ai/core/gateway/ai-gateway.types.ts`). Both are on the
 * wire of four separate surfaces — copilot, demand risk, the report builder and
 * the ops brief — and a per-file copy is how the four end up describing the same
 * object four slightly different ways.
 */
export const invAiProvenanceSchema = z.object({
  contractVersion: z.number().int(),
  promptKey: z.string(),
  promptVersion: z.number().int(),
  model: z.string(),
  correlationId: z.string(),
});

export const aiUsageMetaSchema = z.object({
  model: z.string(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  credits: z.number(),
  costUsd: z.number(),
});
