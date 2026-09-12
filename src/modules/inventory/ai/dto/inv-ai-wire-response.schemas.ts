import { z } from "zod";

/**
 * The two envelopes every inventory AI answer carries, written once.
 *
 * `provenance` is `InvAiProvenance` (`inv-ai-contract.ts`) and `aiUsage` is
 * `AiUsageMeta` (`modules/ai/core/gateway/ai-gateway.types.ts`). Both are on the
 * wire of four separate surfaces — copilot, demand risk, the report builder and
 * the ops brief — and a per-file copy is how the four end up describing the same
 * object four slightly different ways.
 *
 * Both are response contract, not a boundary: nothing parses client input with
 * them, and the only importers are `*-response.schemas.ts`. The `-response`
 * suffix is what says so — `inventory-strict-boundary.spec.ts` reads the role of
 * a schema file off its name, so a shared fragment named anything else is walked
 * as a request DTO and told to be `.strict()`, which a response contract must
 * not be (`ResponseContractInterceptor` throws under NODE_ENV=test, so a strict
 * contract fails every response that gains an additive field).
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
