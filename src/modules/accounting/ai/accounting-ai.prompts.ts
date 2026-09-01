import { z } from "zod";

export const VarianceResponseSchema = z.object({
  narration: z.string(),
  factors: z.array(z.object({
    label: z.string(),
    value: z.string(),
    isFactual: z.boolean(),
  })),
  suggestedInvestigations: z.array(z.string()),
});

export const ReconciliationResponseSchema = z.object({
  narration: z.string(),
  factors: z.array(z.object({
    label: z.string(),
    value: z.string(),
    isFactual: z.boolean(),
  })),
});

export const ExtractedDocumentSchema = z.object({
  vendor: z.string(),
  documentDate: z.string().nullable(),
  documentNumber: z.string().nullable(),
  currency: z.string().default("USD"),
  subtotalAmount: z.number().nullable(),
  taxAmount: z.number().nullable(),
  totalAmount: z.number().nullable(),
  lineItems: z.array(z.object({
    description: z.string(),
    quantity: z.number().nullable(),
    unitPrice: z.number().nullable(),
    lineTotal: z.number().nullable(),
  })),
  paymentTerms: z.string().nullable(),
  notes: z.string().nullable(),
});

export type ExtractedDocument = z.infer<typeof ExtractedDocumentSchema>;

export const VARIANCE_FEATURE = "accounting.variance-explain" as const;
export const RECON_FEATURE = "accounting.reconciliation-explain" as const;
export const EXTRACT_FEATURE = "accounting.extract-document" as const;

export function buildVarianceSystemPrompt(): string {
  return [
    "You are a financial analyst. Your only job is to narrate pre-computed variance evidence.",
    "CRITICAL RULES you must never violate:",
    "1. You MUST NOT compute, invent, or derive any numbers. Every amount, percentage, and period label is provided to you.",
    "2. You MUST NOT contradict the evidence. Reference the exact figures given.",
    "3. Your narration explains WHY this variance is financially significant and what business conditions typically cause it.",
    "4. isFactual=true means the fact comes directly from the evidence data. isFactual=false means it is your analytical suggestion.",
    "5. Keep narration concise (2-4 sentences). suggestedInvestigations should be 2-4 actionable items.",
    "Return valid JSON matching: { narration: string, factors: [{label, value, isFactual}], suggestedInvestigations: string[] }",
  ].join("\n");
}

export function buildVarianceUserPrompt(body: {
  periodLabel: string;
  accountName: string;
  accountCode: string;
  budgetAmount: string | number;
  actualAmount: string | number;
  varianceAmount: string | number;
  variancePct: string | number;
  priorPeriodAmount?: string | number;
  notes?: string;
}): string {
  const lines = [
    `Period: ${body.periodLabel}`,
    `Account: ${body.accountName} (${body.accountCode})`,
    `Budget Amount: ${body.budgetAmount}`,
    `Actual Amount: ${body.actualAmount}`,
    `Variance Amount: ${body.varianceAmount}`,
    `Variance %: ${body.variancePct}%`,
  ];
  if (body.priorPeriodAmount !== undefined) lines.push(`Prior Period Amount: ${body.priorPeriodAmount}`);
  if (body.notes) lines.push(`Notes: ${body.notes}`);
  lines.push("", "Narrate why this variance is significant. Extract factual figures as factors (isFactual: true). Add investigative suggestions (isFactual: false).");
  return lines.join("\n");
}

export function buildReconciliationSystemPrompt(): string {
  return [
    "You are a reconciliation analyst. Your only job is to narrate pre-computed reconciliation evidence.",
    "CRITICAL RULES you must never violate:",
    "1. You MUST NOT compute, invent, or derive any numbers. All amounts, dates, and identifiers are provided to you.",
    "2. You MUST NOT contradict the evidence. Reference the exact figures given.",
    "3. Your narration explains WHY this bank transaction matches this journal entry — same amounts, date proximity, counterparty alignment, etc.",
    "4. isFactual=true means the fact comes directly from the evidence data. isFactual=false means it is your analytical observation.",
    "5. Keep narration concise (2-4 sentences).",
    "Return valid JSON matching: { narration: string, factors: [{label, value, isFactual}] }",
  ].join("\n");
}

export function buildReconciliationUserPrompt(evidence: Record<string, unknown>): string {
  return [
    "Reconciliation match evidence (all values are pre-computed — do not modify or re-derive any numbers):",
    JSON.stringify(evidence, null, 2),
    "",
    "Explain WHY this bank transaction matches this journal entry based on the evidence.",
    "Extract factual match criteria as factors (isFactual: true). Add analytical observations (isFactual: false).",
  ].join("\n");
}

export function buildExtractSystemPrompt(): string {
  return [
    "You are a document extraction specialist. Extract structured financial data from the provided document.",
    "CRITICAL RULES you must never violate:",
    "1. Extract ONLY what is explicitly present in the document. Do not infer or fabricate any values.",
    "2. If a field is not present, return null for that field.",
    "3. Amounts must be numbers only (no currency symbols). Use null if amount is unclear.",
    "4. Return the vendor name exactly as it appears in the document.",
    "5. Document date must be in ISO 8601 format (YYYY-MM-DD) if present.",
    "Return valid JSON matching the ExtractedDocument schema.",
  ].join("\n");
}

export function buildExtractUserPrompt(content: string): string {
  return [
    "Extract all financial data from this document:",
    "",
    content,
    "",
    "Return { vendor, documentDate, documentNumber, currency, subtotalAmount, taxAmount, totalAmount, lineItems: [{description, quantity, unitPrice, lineTotal}], paymentTerms, notes }",
  ].join("\n");
}

export function computeConfidence(draft: ExtractedDocument): "high" | "medium" | "low" {
  const presentCount = [
    draft.vendor,
    draft.documentDate,
    draft.documentNumber,
    draft.totalAmount,
    draft.lineItems.length > 0,
  ].filter(Boolean).length;
  if (presentCount >= 4) return "high";
  if (presentCount >= 2) return "medium";
  return "low";
}
