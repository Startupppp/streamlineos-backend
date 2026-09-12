import { z } from "zod";
import { invEvidenceReferenceSchema } from "../../dto/inv-ai-contract";
import { aiUsageMetaSchema, invAiProvenanceSchema } from "../../dto/inv-ai-wire-response.schemas";

/** `InvCopilotCell` — a projected column, never a nested object. */
const copilotCellSchema = z.union([z.string(), z.number(), z.null()]);

/** `InvCopilotToolResult` (`inv-copilot-tools.ts`): one table, server-authored. */
const copilotToolResultSchema = z.object({
  tool: z.string(),
  label: z.string(),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), copilotCellSchema)),
  rowCount: z.number().int(),
  truncated: z.boolean(),
  evidence: z.array(invEvidenceReferenceSchema),
});

/**
 * `InvCopilotAnswer`. `narration` and `provenance` are both null on
 * `no_context` — the short-circuit that never reaches a provider — and
 * `aiUsage` is absent rather than null there, because nothing was spent.
 */
export const copilotAskResponseSchema = z.object({
  status: z.enum(["answered", "facts_only", "no_context"]),
  question: z.string(),
  narration: z.string().nullable(),
  tools: z.array(copilotToolResultSchema),
  plannedBy: z.enum(["model", "deterministic"]),
  evidence: z.array(invEvidenceReferenceSchema),
  provenance: invAiProvenanceSchema.nullable(),
  aiUsage: aiUsageMetaSchema.optional(),
  generatedAt: z.string(),
});
