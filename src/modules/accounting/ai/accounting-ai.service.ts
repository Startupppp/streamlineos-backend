import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  finReconciliationMatches,
  finBankTransactions,
  journalEntries,
  journalLines,
} from "../../../db/schema";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { extractAttachmentText } from "../../kb/kb-attachment-extract.util";
import type { VarianceExplainInput, ReconciliationExplainInput, ExtractDocumentInput } from "./dto/accounting-ai.dto";

const FactorSchema = z.object({
  label: z.string(),
  value: z.string(),
  isFactual: z.boolean(),
});

const VarianceResponseSchema = z.object({
  narration: z.string(),
  factors: z.array(FactorSchema),
  suggestedInvestigations: z.array(z.string()),
});

const ReconciliationResponseSchema = z.object({
  narration: z.string(),
  factors: z.array(FactorSchema),
});

const ExtractedDocumentSchema = z.object({
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

type ExtractedDocument = z.infer<typeof ExtractedDocumentSchema>;

const VARIANCE_FEATURE = "accounting.variance-explain" as const;
const RECON_FEATURE = "accounting.reconciliation-explain" as const;
const EXTRACT_FEATURE = "accounting.extract-document" as const;

function buildVarianceSystemPrompt(): string {
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

function buildVarianceUserPrompt(body: VarianceExplainInput): string {
  const lines = [
    `Period: ${body.periodLabel}`,
    `Account: ${body.accountName} (${body.accountCode})`,
    `Budget Amount: ${body.budgetAmount}`,
    `Actual Amount: ${body.actualAmount}`,
    `Variance Amount: ${body.varianceAmount}`,
    `Variance %: ${body.variancePct}%`,
  ];
  if (body.priorPeriodAmount !== undefined) {
    lines.push(`Prior Period Amount: ${body.priorPeriodAmount}`);
  }
  if (body.notes) {
    lines.push(`Notes: ${body.notes}`);
  }
  lines.push("", "Narrate why this variance is significant. Extract factual figures as factors (isFactual: true). Add investigative suggestions (isFactual: false).");
  return lines.join("\n");
}

function buildReconciliationSystemPrompt(): string {
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

function buildReconciliationUserPrompt(evidence: Record<string, unknown>): string {
  return [
    "Reconciliation match evidence (all values are pre-computed — do not modify or re-derive any numbers):",
    JSON.stringify(evidence, null, 2),
    "",
    "Explain WHY this bank transaction matches this journal entry based on the evidence.",
    "Extract factual match criteria as factors (isFactual: true). Add analytical observations (isFactual: false).",
  ].join("\n");
}

function buildExtractSystemPrompt(): string {
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

function buildExtractUserPrompt(content: string): string {
  return [
    "Extract all financial data from this document:",
    "",
    content,
    "",
    "Return { vendor, documentDate, documentNumber, currency, subtotalAmount, taxAmount, totalAmount, lineItems: [{description, quantity, unitPrice, lineTotal}], paymentTerms, notes }",
  ].join("\n");
}

function computeConfidence(draft: ExtractedDocument): "high" | "medium" | "low" {
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

@Injectable()
export class AccountingAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
  ) {}

  async explainVariance(orgId: string, userId: string, body: VarianceExplainInput) {
    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: VARIANCE_FEATURE,
      tier: "fast",
      maxTokens: 600,
      charge: true,
      redact: false,
      schema: VarianceResponseSchema,
      prompt: {
        system: buildVarianceSystemPrompt(),
        user: buildVarianceUserPrompt(body),
        promptKey: "accounting.variance-explain",
        promptVersion: 1,
      },
    });

    if (!result.ok) throw new ServiceUnavailableException(result.message);

    return {
      narration: result.data.narration,
      factors: result.data.factors,
      suggestedInvestigations: result.data.suggestedInvestigations,
      evidenceSnapshot: {
        periodLabel: body.periodLabel,
        accountName: body.accountName,
        accountCode: body.accountCode,
        budgetAmount: body.budgetAmount,
        actualAmount: body.actualAmount,
        varianceAmount: body.varianceAmount,
        variancePct: body.variancePct,
        priorPeriodAmount: body.priorPeriodAmount,
        notes: body.notes,
      },
      generatedAt: new Date(),
    };
  }

  async explainReconciliation(orgId: string, userId: string, body: ReconciliationExplainInput) {
    const match = await this.db.query.finReconciliationMatches.findFirst({
      where: and(
        eq(finReconciliationMatches.id, body.matchId),
        eq(finReconciliationMatches.orgId, orgId),
      ),
    });

    if (!match || match.orgId !== orgId) throw new NotFoundException("Reconciliation match not found");

    const txn = match.bankTransactionId
      ? await this.db.query.finBankTransactions.findFirst({
          where: eq(finBankTransactions.id, match.bankTransactionId),
        })
      : null;

    const je = match.journalEntryId
      ? await this.db.query.journalEntries.findFirst({
          where: eq(journalEntries.id, match.journalEntryId),
        })
      : null;

    const jeLinesRow = je
      ? await this.db
          .select({
            totalDebit: sql<string>`COALESCE(SUM(${journalLines.debit}::numeric), 0)::text`,
            totalCredit: sql<string>`COALESCE(SUM(${journalLines.credit}::numeric), 0)::text`,
          })
          .from(journalLines)
          .where(eq(journalLines.entryId, je.id))
          .then((rows) => rows[0])
      : null;

    const evidence: Record<string, unknown> = {
      matchId: match.id,
      matchedType: match.matchedType,
      matchAmount: match.amount,
      confidence: match.confidence,
      isConfirmed: match.isConfirmed,
      bankTransaction: txn
        ? {
            id: txn.id,
            txnDate: txn.txnDate,
            amount: txn.amount,
            description: txn.description,
            counterparty: txn.counterparty,
            reference: txn.reference,
            status: txn.status,
          }
        : null,
      journalEntry: je
        ? {
            id: je.id,
            entryNumber: je.entryNumber,
            entryDate: je.entryDate,
            description: je.description,
            status: je.status,
            totalDebit: jeLinesRow?.totalDebit,
            totalCredit: jeLinesRow?.totalCredit,
          }
        : null,
    };

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: RECON_FEATURE,
      tier: "fast",
      maxTokens: 512,
      charge: true,
      redact: false,
      schema: ReconciliationResponseSchema,
      prompt: {
        system: buildReconciliationSystemPrompt(),
        user: buildReconciliationUserPrompt(evidence),
        promptKey: "accounting.reconciliation-explain",
        promptVersion: 1,
      },
    });

    if (!result.ok) throw new ServiceUnavailableException(result.message);

    return {
      narration: result.data.narration,
      factors: result.data.factors,
      evidenceSnapshot: {
        matchId: match.id,
        matchedType: match.matchedType,
        bankTxn: txn
          ? {
              date: txn.txnDate,
              amount: Number(txn.amount),
              description: txn.description ?? "",
              counterparty: txn.counterparty ?? undefined,
            }
          : { date: "", amount: 0, description: "" },
        journalEntry: je
          ? {
              entryNumber: je.entryNumber,
              entryDate: je.entryDate,
              description: je.description ?? "",
              totalDebit: Number(jeLinesRow?.totalDebit ?? 0),
              totalCredit: Number(jeLinesRow?.totalCredit ?? 0),
            }
          : undefined,
        confidence: match.confidence !== null ? Number(match.confidence) : undefined,
        isConfirmed: match.isConfirmed,
      },
      generatedAt: new Date(),
    };
  }

  async extractDocument(orgId: string, userId: string, body: ExtractDocumentInput) {
    const isImage = ["image/jpeg", "image/png", "image/webp"].includes(body.mimeType);

    let result;

    if (isImage) {
      result = await this.gateway.invokeStructuredWithImage({
        actor: { orgId, userId },
        feature: EXTRACT_FEATURE,
        tier: "fast",
        maxTokens: 1024,
        charge: true,
        redact: false,
        schema: ExtractedDocumentSchema,
        images: [body.fileBase64],
        prompt: {
          system: buildExtractSystemPrompt(),
          user: "Extract all financial data from this document image. Return the structured JSON.",
          promptKey: "accounting.extract-document",
          promptVersion: 1,
        },
      });
    } else {
      const buffer = Buffer.from(body.fileBase64, "base64");
      const textContent = await extractAttachmentText(buffer, body.mimeType);

      result = await this.gateway.invokeStructured({
        actor: { orgId, userId },
        feature: EXTRACT_FEATURE,
        tier: "fast",
        maxTokens: 1024,
        charge: true,
        redact: false,
        schema: ExtractedDocumentSchema,
        prompt: {
          system: buildExtractSystemPrompt(),
          user: buildExtractUserPrompt(textContent),
          promptKey: "accounting.extract-document",
          promptVersion: 1,
        },
      });
    }

    if (!result.ok) throw new ServiceUnavailableException(result.message);

    const draft = result.data;

    return {
      draft,
      sourceDocumentName: body.sourceDocumentName,
      mimeType: body.mimeType,
      confidence: computeConfidence(draft),
      reviewRequired: true as const,
      warningMessage: "This is an AI-generated draft. Review all fields before creating a bill or expense.",
      generatedAt: new Date(),
    };
  }
}
