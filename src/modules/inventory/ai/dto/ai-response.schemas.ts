import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";
import { vendorScorecardSchema } from "../../vendors/dto/vendors-response.schemas";

const aiInsightSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  insightType: z.string(),
  severity: z.string(),
  title: z.string(),
  body: z.string(),
  sourceRefs: z.record(z.string(), z.unknown()).nullable(),
  status: z.string(),
  createdAt: wireDate(),
});

export const listInsightsResponseSchema = itemsPagedSchema(aiInsightSchema);

export const generateInsightsResponseSchema = z.object({ generated: z.number().int() });

export const updateInsightStatusResponseSchema = aiInsightSchema;

const explainFactorSchema = z.object({
  label: z.string(),
  value: z.string(),
  isFactual: z.boolean(),
});

const evidenceReferenceSchema = z.object({ kind: z.string(), id: z.number().int() });

/** `InsightNarration` (`ai/inv-ai-narration.ts`): actions are resolved server-side, never free text. */
const insightNarrationSchema = z.object({
  status: z.string(),
  explanation: z.string(),
  factors: z.array(explainFactorSchema),
  actions: z.array(z.object({
    action: z.string(),
    label: z.string(),
    href: z.string().nullable(),
    permission: z.string(),
    mutates: z.boolean(),
    rationale: z.string(),
    evidence: z.array(evidenceReferenceSchema),
  })),
  evidenceSnapshot: z.record(z.string(), z.unknown()),
  provenance: z.object({
    contractVersion: z.number().int(),
    promptKey: z.string(),
    promptVersion: z.number().int(),
    model: z.string(),
    correlationId: z.string(),
  }),
});

export const explainInsightResponseSchema = insightNarrationSchema;

const digestSampleSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  body: z.string(),
  severity: z.string(),
});

const digestGroupSchema = z.object({
  insightType: z.string(),
  count: z.number().int(),
  severityCounts: z.record(z.string(), z.number()),
  samples: z.array(digestSampleSchema),
});

export const digestResponseSchema = z.object({
  groups: z.array(digestGroupSchema),
  totalNew: z.number().int(),
  narration: z.string().optional(),
});

/** `InvAiProposalEvidence`: every quantity an exact decimal string, all server-computed. */
const proposalEvidenceSchema = z.object({
  proposalId: z.number().int(),
  productVariantId: z.number().int(),
  variantSku: z.string(),
  productName: z.string(),
  warehouseId: z.number().int().nullable(),
  warehouseName: z.string().nullable(),
  vendorId: z.number().int().nullable(),
  vendorName: z.string().nullable(),
  currency: z.string().nullable(),
  generatedAt: z.string(),
  reorderPoint: z.string().nullable(),
  suggestedQuantity: z.string(),
  unitCost: z.string(),
  duplicateOfPoNumber: z.string().nullable(),
  blockedReason: z.string().nullable(),
});

/** `InvAiProposalResult` (`ai/proposals/inv-ai-proposal.service.ts`). */
export const reorderProposalResponseSchema = z.object({
  status: z.enum(["proposed", "blocked"]),
  evidence: proposalEvidenceSchema,
  forecast: z.record(z.string(), z.unknown()),
  explanation: insightNarrationSchema.nullable(),
  proposal: z.object({
    proposalId: z.number().int(),
    token: z.string(),
    expiresAt: wireDate(),
  }).nullable(),
  blockedReason: z.string().nullable(),
});

/** `CreatedPoBatch` (`replenishment/forecast/po-batch.service.ts`): a summary, not the PO row. */
export const confirmReorderProposalResponseSchema = z.object({
  poId: z.number().int(),
  poNumber: z.string(),
  vendorId: z.number().int(),
  warehouseId: z.number().int().nullable(),
  currency: z.string(),
  lineCount: z.number().int(),
  total: z.string(),
  requiresApproval: z.boolean(),
  nextStep: z.string(),
  created: z.boolean(),
});


const supplierVendorSchema = z.object({
  vendorId: z.number().int(),
  vendorName: z.string(),
  insightCount: z.number().int(),
  insights: z.array(z.object({
    id: z.number().int(),
    title: z.string(),
    body: z.string(),
    severity: z.string(),
  })),
  performance: vendorScorecardSchema,
});

export const supplierDelayBriefingResponseSchema = z.object({
  vendors: z.array(supplierVendorSchema),
  narration: z.string(),
  generatedAt: wireDate(),
});

/**
 * `InventoryOpsBrief` (`inv-ai.service.ts`): one row per detector, each with the
 * deterministic route that recomputes it. `severity` is the worst thing present
 * rather than an average, and it reaches the wire through a cast over a database
 * value, so it is declared as the string it is.
 */
const opsBriefSchema = z.object({
  generatedAt: z.string(),
  totalSignals: z.number().int(),
  signals: z.array(z.object({
    key: z.string(),
    label: z.string(),
    href: z.string(),
    count: z.number().int(),
    severity: z.string(),
  })),
});

export const opsBriefResponseSchema = opsBriefSchema;

/** The paid half: the same brief, plus the narration built over it. */
export const narrateOpsBriefResponseSchema = z.object({
  brief: opsBriefSchema,
  narration: insightNarrationSchema,
});
