import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";
import { invPoSchema } from "../../purchase-orders/dto/purchase-orders-response.schemas";

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

export const explainInsightResponseSchema = z.object({
  explanation: z.string(),
  factors: z.array(explainFactorSchema),
  suggestedActions: z.array(z.string()),
  evidenceSnapshot: z.record(z.string(), z.unknown()),
});

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

const explainResponseSchema = z.object({
  explanation: z.string(),
  factors: z.array(explainFactorSchema),
  suggestedActions: z.array(z.string()),
});

const reorderEvidenceSchema = z.object({
  productVariantId: z.number().int(),
  variantSku: z.string(),
  variantName: z.string(),
  productName: z.string(),
  currentOnHand: z.number(),
  forecastedQty: z.number(),
  suggestedOrderQty: z.number(),
  vendorId: z.number().int().nullable(),
  leadTimeDays: z.number().int(),
  expectedDeliveryDate: z.string(),
  reorderReason: z.string(),
  warehouseId: z.number().int().nullable(),
  warehouseName: z.string().nullable(),
});

export const reorderProposalResponseSchema = z.object({
  evidence: reorderEvidenceSchema,
  explanation: explainResponseSchema,
  proposal: z.object({
    proposalId: z.number().int(),
    token: z.string(),
    expiresAt: wireDate(),
  }),
});

export { invPoSchema as confirmReorderProposalResponseSchema };

const vendorPerformanceSchema = z.object({
  vendorId: z.number().int(),
  onTimeRate: z.number(),
  fillRate: z.number(),
  avgLeadTimeDays: z.number(),
  returnRate: z.number(),
  openPoCount: z.number().int(),
  totalSpend: z.string(),
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
  performance: vendorPerformanceSchema,
});

export const supplierDelayBriefingResponseSchema = z.object({
  vendors: z.array(supplierVendorSchema),
  narration: z.string(),
  generatedAt: wireDate(),
});
