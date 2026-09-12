/**
 * The journal an AR document posts. The documents service computes and emits a
 * `PostJournalCommand`; it never writes a journal line — the ledger does.
 */
import { BadRequestException } from "@nestjs/common";
import type { ArDocumentType, GlJournalSource } from "../../../../db/schema";
import type { BooksService } from "../../kernel/books.service";
import type { PostJournalCommand, PostJournalLineCommand } from "../../kernel/ledger.types";
import type { DbOrTx } from "../../kernel/sequence.service";
import type { PartyDetail } from "../../parties/parties.service";
import type { DetermineResult } from "../../tax/tax.service";
import type { ArDocumentHeader, ComputedLine } from "../ar-documents.types";
import { toFunctional } from "./ar-document-maths";

/** `document_type` as the ledger and the frozen tax rows spell it. */
export const SOURCE_TYPE: Record<ArDocumentType, GlJournalSource> = {
  INVOICE: "sales_invoice",
  CREDIT_NOTE: "credit_note",
};

/**
 * Dr AR control (gross) · Cr revenue per line (net) · Cr tax per component.
 * A credit note is the exact mirror — same lines, sides swapped.
 */
export async function buildJournalCommand(
  books: BooksService,
  args: {
    orgId: string;
    header: ArDocumentHeader;
    party: PartyDetail;
    book: { id: string; baseCurrency: string; countryCode: string; localizationPack: string };
    computed: ComputedLine[];
    determined: DetermineResult;
    netMinor: number;
    taxMinor: number;
    grossMinor: number;
    documentNumber: string;
    tx: DbOrTx;
  },
): Promise<PostJournalCommand> {
  const { header, party, book, computed, determined, grossMinor, documentNumber, tx } = args;
  const isInvoice = header.documentType === "INVOICE";
  const base = book.baseCurrency;
  const currency = header.currency;
  const sameCurrency = currency === base;
  const fxRate = sameCurrency ? "1" : header.fxRate;

  const arAccountId = await books.resolveAccountByTag(header.bookId, "ar_control", tx);
  const fallbackIncomeId =
    party.defaultIncomeAccountId ??
    (await books.resolveAccountByTag(header.bookId, "sales", tx));

  const lines: PostJournalLineCommand[] = [];

  const push = (
    accountId: string,
    side: "debit" | "credit",
    txnAmountMinor: number,
    extra: Partial<PostJournalLineCommand> = {},
    lineCurrency = currency,
    lineRate = fxRate,
  ) => {
    if (txnAmountMinor <= 0) return;
    const functional = toFunctional(txnAmountMinor, lineCurrency, base, lineRate);
    if (functional <= 0) return;
    lines.push({
      accountId,
      ...(side === "debit" ? { debitMinor: functional } : { creditMinor: functional }),
      txnCurrency: lineCurrency,
      txnAmountMinor,
      fxRate: lineCurrency === base ? "1" : lineRate,
      ...extra,
    });
  };

  const arSide = isInvoice ? "debit" : "credit";
  const otherSide = isInvoice ? "credit" : "debit";

  push(arAccountId, arSide, grossMinor, {
    partyId: header.partyId,
    description: `${documentNumber} — ${party.displayName}`,
  });

  for (const line of computed) {
    push(line.incomeAccountId ?? fallbackIncomeId, otherSide, line.netMinor, {
      partyId: header.partyId,
      dimensionProjectId: line.dimensionProjectId ?? header.dimensionProjectId ?? undefined,
      dimensionCostCenterId: line.dimensionCostCenterId ?? undefined,
      description: line.description,
    });
  }

  // One credit per (role, component, code) rather than per line — the GL wants
  // "Output CGST 900", not eleven rows that add up to it.
  for (const bucket of aggregateTax(determined)) {
    const accountId = determined.accountByRoleAndComponent.get(bucket.key);
    if (!accountId) {
      throw new BadRequestException(
        `No GL account is mapped for ${bucket.key}. Re-run the tax pack setup for this book.`,
      );
    }
    push(accountId, otherSide, bucket.taxMinor, {
      partyId: header.partyId,
      taxCodeId: bucket.taxCodeId ?? undefined,
      taxComponent: bucket.component,
      description: `${bucket.component} on ${documentNumber}`,
    });
  }

  // The kernel balances at zero tolerance, so any residue — a pack's document
  // rounding, or the paise lost converting each line separately — is posted
  // explicitly rather than papered over.
  const debit = lines.reduce((a, l) => a + (l.debitMinor ?? 0), 0);
  const credit = lines.reduce((a, l) => a + (l.creditMinor ?? 0), 0);
  const difference = debit - credit;
  if (difference !== 0) {
    const roundingAccountId = await books.resolveAccountByTag(header.bookId, "rounding", tx);
    push(
      roundingAccountId,
      difference > 0 ? "credit" : "debit",
      Math.abs(difference),
      { description: `Rounding on ${documentNumber}` },
      base,
      "1",
    );
  }

  return {
    bookId: header.bookId,
    idempotencyKey: `${SOURCE_TYPE[header.documentType]}:${header.id}:post`,
    journalDate: header.issueDate,
    memo: `${documentNumber} — ${party.displayName}`,
    sourceType: SOURCE_TYPE[header.documentType],
    sourceId: header.id,
    lines,
  };
}

function aggregateTax(determined: DetermineResult) {
  const buckets = new Map<
    string,
    { key: string; component: string; taxCodeId: string | null; taxMinor: number }
  >();
  for (const line of determined.lines) {
    for (const component of line.components) {
      const key = `${component.glRole}:${component.code}`;
      const bucketKey = `${key}|${line.taxCodeId ?? ""}`;
      const existing = buckets.get(bucketKey);
      if (existing) existing.taxMinor += component.taxMinor;
      else {
        buckets.set(bucketKey, {
          key,
          component: component.code,
          taxCodeId: line.taxCodeId,
          taxMinor: component.taxMinor,
        });
      }
    }
  }
  return [...buckets.values()].filter((b) => b.taxMinor > 0);
}
