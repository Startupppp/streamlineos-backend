import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { baseCreditAmount, baseDebitAmount } from "../core/journal-base-amount";
import {
  finReconciliationMatches,
  finBankTransactions,
  journalEntries,
  journalLines,
} from "../../../db/schema";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { extractAttachmentText } from "../../kb/retrieval/kb-attachment-extract.util";
import type { VarianceExplainInput, ReconciliationExplainInput, ExtractDocumentInput } from "./dto/accounting-ai.dto";
import {
  VarianceResponseSchema,
  ReconciliationResponseSchema,
  ExtractedDocumentSchema,
  VARIANCE_FEATURE,
  RECON_FEATURE,
  EXTRACT_FEATURE,
  buildVarianceSystemPrompt,
  buildVarianceUserPrompt,
  buildReconciliationSystemPrompt,
  buildReconciliationUserPrompt,
  buildExtractSystemPrompt,
  buildExtractUserPrompt,
  computeConfidence,
} from "./accounting-ai.prompts";

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
            totalDebit: sql<string>`COALESCE(SUM(${baseDebitAmount}::numeric), 0)::text`,
            totalCredit: sql<string>`COALESCE(SUM(${baseCreditAmount}::numeric), 0)::text`,
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
