import { z } from "zod";

/**
 * INV-102 — the contract every AI inventory response is held to.
 *
 * The rule the whole file exists to enforce: a model may *select* and it may
 * *explain*, but it may never *supply*. No field here becomes SQL, a route, a
 * permission key, a quantity or a mutation. Where the old
 * `ExplainResponseSchema` had `suggestedActions: z.array(z.string())` — free
 * model text rendered to an operator as things to go and do — this has a closed
 * enum that the server resolves into a route and a permission on its own side.
 *
 * The version travels with every stored artefact. A schema change that alters
 * meaning bumps it, so a narrative persisted under contract 1 is never replayed
 * as though it were contract 2.
 */
export const INV_AI_CONTRACT_VERSION = 1 as const;

/**
 * Bounds are part of the contract, not defensive decoration. An unbounded
 * string is a rendering problem, a storage problem and a prompt-injection
 * carrier all at once, and `.max()` is the only thing standing between a
 * confused model and a 40KB "explanation" in a table cell.
 */
const HEADLINE_MAX = 160;
const TEXT_MAX = 1_200;
const MAX_FACTORS = 8;
const MAX_RECOMMENDATIONS = 4;
const MAX_EVIDENCE_REFS = 20;
const MAX_MISSING = 8;

/**
 * The kinds of thing a model is allowed to point at. A reference is a
 * (kind, id) pair against a row the server itself retrieved — never a free
 * string, because a free string is how an invented citation gets rendered as a
 * real one.
 */
export const INV_EVIDENCE_KINDS = [
  "insight",
  "product_variant",
  "purchase_order",
  "stock_transaction",
  "lot",
  "vendor",
  "warehouse",
  "reorder_suggestion",
] as const;
export type InvEvidenceKind = (typeof INV_EVIDENCE_KINDS)[number];

export const invEvidenceReferenceSchema = z
  .object({
    kind: z.enum(INV_EVIDENCE_KINDS),
    id: z.number().int().positive(),
  })
  .strict();
export type InvEvidenceReference = z.infer<typeof invEvidenceReferenceSchema>;

/**
 * The closed set of actions a model may name. It names one; it never describes
 * one. Everything an action needs in order to happen — the route, the
 * permission, whether it mutates, which record it targets — is supplied by
 * `inv-ai-action-resolver` from server-held evidence.
 *
 * Adding a member here is a deliberate act with a resolver entry beside it; the
 * resolver's exhaustive table means a new action cannot be added without
 * deciding what it costs.
 */
export const INV_AI_ACTIONS = [
  "review_reorder_suggestion",
  "draft_purchase_order",
  "open_stock_movements",
  "open_expiry_report",
  "review_vendor_performance",
  "acknowledge_insight",
  "dismiss_insight",
] as const;
export type InvAiAction = (typeof INV_AI_ACTIONS)[number];

export const invAiActionSchema = z.enum(INV_AI_ACTIONS);

/**
 * `isFactual` separates a number the server computed from a sentence the model
 * wrote about it. The frontend renders the two differently, so collapsing them
 * would let a generated figure wear the styling of a measured one.
 */
export const invAiFactorSchema = z
  .object({
    label: z.string().min(1).max(HEADLINE_MAX),
    value: z.string().min(1).max(HEADLINE_MAX),
    isFactual: z.boolean(),
  })
  .strict();
export type InvAiFactor = z.infer<typeof invAiFactorSchema>;

export const invAiRecommendationSchema = z
  .object({
    action: invAiActionSchema,
    rationale: z.string().min(1).max(TEXT_MAX),
    evidence: z.array(invEvidenceReferenceSchema).max(MAX_EVIDENCE_REFS),
  })
  .strict();
export type InvAiRecommendation = z.infer<typeof invAiRecommendationSchema>;

export const invAiInsightSchema = z
  .object({
    headline: z.string().min(1).max(HEADLINE_MAX),
    summary: z.string().min(1).max(TEXT_MAX),
    severity: z.enum(["high", "medium", "low"]),
    evidence: z.array(invEvidenceReferenceSchema).max(MAX_EVIDENCE_REFS),
  })
  .strict();
export type InvAiInsight = z.infer<typeof invAiInsightSchema>;

export const invAiDigestSchema = z
  .object({
    status: z.literal("ok"),
    headline: z.string().min(1).max(HEADLINE_MAX),
    insights: z.array(invAiInsightSchema).max(MAX_FACTORS),
  })
  .strict();
export type InvAiDigest = z.infer<typeof invAiDigestSchema>;

export const invAiNarrativeSchema = z
  .object({
    status: z.literal("ok"),
    explanation: z.string().min(1).max(TEXT_MAX),
    factors: z.array(invAiFactorSchema).max(MAX_FACTORS),
    recommendations: z.array(invAiRecommendationSchema).max(MAX_RECOMMENDATIONS),
  })
  .strict();
export type InvAiNarrative = z.infer<typeof invAiNarrativeSchema>;

/**
 * Two refusal states, deliberately distinct.
 *
 * `insufficient_evidence` is the model reporting that the deterministic layer
 * did not give it enough to answer — a fact about our query, and the state that
 * must exist if "answer anyway" is not to be the only alternative.
 * `refused` is the model declining. Collapsing them into an empty success would
 * render as "no problems found", which is a different and much worse claim.
 */
export const invAiInsufficientEvidenceSchema = z
  .object({
    status: z.literal("insufficient_evidence"),
    missing: z.array(z.string().min(1).max(HEADLINE_MAX)).min(1).max(MAX_MISSING),
  })
  .strict();

export const invAiRefusalSchema = z
  .object({
    status: z.literal("refused"),
    reason: z.string().min(1).max(HEADLINE_MAX),
  })
  .strict();

export const invAiNarrativeResponseSchema = z.discriminatedUnion("status", [
  invAiNarrativeSchema,
  invAiInsufficientEvidenceSchema,
  invAiRefusalSchema,
]);
export type InvAiNarrativeResponse = z.infer<typeof invAiNarrativeResponseSchema>;

export const invAiDigestResponseSchema = z.discriminatedUnion("status", [
  invAiDigestSchema,
  invAiInsufficientEvidenceSchema,
  invAiRefusalSchema,
]);
export type InvAiDigestResponse = z.infer<typeof invAiDigestResponseSchema>;

/**
 * What produced an artefact, recorded beside it. Without the contract and
 * prompt versions a stored narrative cannot be re-read safely later, and
 * without the model and correlation id a bad answer cannot be traced back to
 * the call that produced it.
 */
export interface InvAiProvenance {
  contractVersion: typeof INV_AI_CONTRACT_VERSION;
  promptKey: string;
  promptVersion: number;
  model: string;
  correlationId: string;
}

export function evidenceRefKey(ref: InvEvidenceReference): string {
  return `${ref.kind}:${ref.id}`;
}
