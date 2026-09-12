/**
 * An AR document's lines: the document as `get` returns it, the computed lines
 * preview and posting work from, and the wholesale replace a draft edit does.
 */
import { BadRequestException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { arDocumentLines, arDocuments } from "../../../../db/schema";
import type { DbOrTx } from "../../kernel/sequence.service";
import type { ArDocumentLineInput } from "../dto/ar-documents.schemas";
import type { ArDocumentView, ComputedLine } from "../ar-documents.types";
import { loadHeader, toHeaderView } from "./ar-document-header";
import { computeLineNetMinor } from "./ar-document-maths";

/** One document and its lines in line order — what `ArDocumentsService.get` returns. */
export async function readArDocument(
  orgId: string,
  documentId: string,
  tx: DbOrTx,
): Promise<ArDocumentView> {
  const header = await loadHeader(orgId, documentId, tx);
  const lines = await tx
    .select({
      id: arDocumentLines.id,
      lineNo: arDocumentLines.lineNo,
      description: arDocumentLines.description,
      quantityMilli: arDocumentLines.quantityMilli,
      unit: arDocumentLines.unit,
      unitPriceMinor: arDocumentLines.unitPriceMinor,
      discountMinor: arDocumentLines.discountMinor,
      taxCategory: arDocumentLines.taxCategory,
      commodityCode: arDocumentLines.commodityCode,
      forcedTaxCodeId: arDocumentLines.forcedTaxCodeId,
      forcedTaxReason: arDocumentLines.forcedTaxReason,
      incomeAccountId: arDocumentLines.incomeAccountId,
      lineNetMinor: arDocumentLines.lineNetMinor,
      lineTaxMinor: arDocumentLines.lineTaxMinor,
      lineGrossMinor: arDocumentLines.lineGrossMinor,
      dimensionProjectId: arDocumentLines.dimensionProjectId,
      dimensionCostCenterId: arDocumentLines.dimensionCostCenterId,
    })
    .from(arDocumentLines)
    .where(eq(arDocumentLines.documentId, documentId))
    .orderBy(asc(arDocumentLines.lineNo));

  return { ...toHeaderView(header), lines };
}

export async function loadComputedLines(documentId: string, tx: DbOrTx): Promise<ComputedLine[]> {
  const rows = await tx
    .select({
      id: arDocumentLines.id,
      lineNo: arDocumentLines.lineNo,
      description: arDocumentLines.description,
      quantityMilli: arDocumentLines.quantityMilli,
      unitPriceMinor: arDocumentLines.unitPriceMinor,
      discountMinor: arDocumentLines.discountMinor,
      taxCategory: arDocumentLines.taxCategory,
      commodityCode: arDocumentLines.commodityCode,
      forcedTaxCodeId: arDocumentLines.forcedTaxCodeId,
      incomeAccountId: arDocumentLines.incomeAccountId,
      dimensionProjectId: arDocumentLines.dimensionProjectId,
      dimensionCostCenterId: arDocumentLines.dimensionCostCenterId,
    })
    .from(arDocumentLines)
    .where(eq(arDocumentLines.documentId, documentId))
    .orderBy(asc(arDocumentLines.lineNo));

  return rows.map((row) => {
    const netMinor = computeLineNetMinor(
      row.quantityMilli,
      row.unitPriceMinor,
      row.discountMinor,
    );
    if (netMinor < 0) {
      throw new BadRequestException(
        `Line ${row.lineNo}: the discount exceeds the line amount`,
      );
    }
    return {
      id: row.id,
      lineNo: row.lineNo,
      description: row.description,
      netMinor,
      taxMinor: 0,
      grossMinor: netMinor,
      incomeAccountId: row.incomeAccountId,
      taxCategory: row.taxCategory,
      commodityCode: row.commodityCode,
      forcedTaxCodeId: row.forcedTaxCodeId,
      dimensionProjectId: row.dimensionProjectId,
      dimensionCostCenterId: row.dimensionCostCenterId,
    };
  });
}

export async function replaceLines(
  orgId: string,
  documentId: string,
  lines: readonly ArDocumentLineInput[],
  tx: DbOrTx,
): Promise<void> {
  await tx.delete(arDocumentLines).where(eq(arDocumentLines.documentId, documentId));
  await tx.insert(arDocumentLines).values(
    lines.map((line, index) => ({
      orgId,
      documentId,
      lineNo: index + 1,
      description: line.description,
      quantityMilli: line.quantityMilli ?? 1000,
      unit: line.unit ?? null,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor: line.discountMinor ?? 0,
      taxCategory: line.taxCategory ?? "standard",
      commodityCode: line.commodityCode ?? null,
      forcedTaxCodeId: line.forcedTaxCodeId ?? null,
      forcedTaxReason: line.forcedTaxReason ?? null,
      incomeAccountId: line.incomeAccountId ?? null,
      lineNetMinor: computeLineNetMinor(
        line.quantityMilli ?? 1000,
        line.unitPriceMinor,
        line.discountMinor ?? 0,
      ),
      lineGrossMinor: computeLineNetMinor(
        line.quantityMilli ?? 1000,
        line.unitPriceMinor,
        line.discountMinor ?? 0,
      ),
      dimensionProjectId: line.dimensionProjectId ?? null,
      dimensionCostCenterId: line.dimensionCostCenterId ?? null,
    })),
  );
}

/**
 * Keep a draft's header totals in step with its lines. Tax stays zero until
 * the document posts — a draft has no frozen verdict, only a preview.
 */
export async function refreshDraftTotals(documentId: string, tx: DbOrTx): Promise<void> {
  const lines = await loadComputedLines(documentId, tx);
  const netMinor = lines.reduce((a, l) => a + l.netMinor, 0);
  await tx
    .update(arDocuments)
    .set({ netMinor, taxMinor: 0, grossMinor: netMinor })
    .where(eq(arDocuments.id, documentId));
}
