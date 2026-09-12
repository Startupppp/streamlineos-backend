/**
 * The pure half of posting a journal: the date, each line's defaults and
 * structural checks, the balance, and the lines a reversal posts.
 *
 * Nothing here reads or writes a row. Split out of `ledger.service.ts`, which
 * calls these inside its posting transaction and stays the only service that
 * writes the ledger (`ledger-boundary.spec.ts`).
 */
import { assertIsoDate } from "../fiscal-calendar";
import { assertCurrencyCode, assertSafeMinor } from "../money";
import {
  LedgerRejection,
  type PostJournalLineCommand,
  type PostedJournal,
} from "../ledger.types";

/** A line after defaults are applied and every field is known. */
export interface NormalizedLine {
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  txnCurrency: string;
  txnAmountMinor: number;
  functionalCurrency: string;
  functionalAmountMinor: number;
  fxRate: string;
  fxRateId: string | null;
  partyId: string | null;
  taxCodeId: string | null;
  taxComponent: string | null;
  dimensionBranchId: string | null;
  dimensionProjectId: number | null;
  dimensionCostCenterId: string | null;
  dimensionValues: Record<string, string> | null;
  description: string | null;
}

export function validateDate(value: string): string {
  try {
    return assertIsoDate(value);
  } catch {
    throw new LedgerRejection("PERIOD_NOT_FOUND", `Invalid journal date: ${value}`);
  }
}

/**
 * Fill defaults and reject anything structurally wrong, before a single row
 * is read. Pure enough to unit-test without a database.
 */
export function normalizeLines(
  lines: readonly PostJournalLineCommand[],
  baseCurrency: string,
): NormalizedLine[] {
  if (!lines || lines.length === 0) {
    throw new LedgerRejection("EMPTY_JOURNAL", "A journal needs at least one line");
  }

  return lines.map((line, index) => {
    const debitMinor = line.debitMinor ?? 0;
    const creditMinor = line.creditMinor ?? 0;

    if (debitMinor < 0 || creditMinor < 0) {
      throw new LedgerRejection(
        "LINE_AMOUNT_INVALID",
        `Line ${index + 1}: amounts cannot be negative`,
        index,
      );
    }
    if ((debitMinor > 0) === (creditMinor > 0)) {
      throw new LedgerRejection(
        "LINE_SIDE_INVALID",
        `Line ${index + 1}: exactly one of debit or credit must be greater than zero`,
        index,
      );
    }
    assertSafeMinor(debitMinor);
    assertSafeMinor(creditMinor);

    const functionalAmountMinor = Math.max(debitMinor, creditMinor);
    const txnCurrency = assertCurrencyCode(line.txnCurrency ?? baseCurrency);
    const txnAmountMinor = line.txnAmountMinor ?? functionalAmountMinor;

    if (!Number.isInteger(txnAmountMinor) || txnAmountMinor <= 0) {
      throw new LedgerRejection(
        "LINE_AMOUNT_INVALID",
        `Line ${index + 1}: transaction amount must be a positive whole number of minor units`,
        index,
      );
    }

    if (
      line.functionalAmountMinor !== undefined &&
      line.functionalAmountMinor !== functionalAmountMinor
    ) {
      throw new LedgerRejection(
        "LINE_AMOUNT_INVALID",
        `Line ${index + 1}: functional amount ${line.functionalAmountMinor} does not match the ` +
          `${debitMinor > 0 ? "debit" : "credit"} of ${functionalAmountMinor}`,
        index,
      );
    }

    const sameCurrency = txnCurrency === baseCurrency;
    const fxRate = line.fxRate ?? "1";
    if (sameCurrency) {
      if (Number(fxRate) !== 1) {
        throw new LedgerRejection(
          "FX_RATE_INVALID",
          `Line ${index + 1}: a ${baseCurrency} line must carry rate 1, got ${fxRate}`,
          index,
        );
      }
      if (txnAmountMinor !== functionalAmountMinor) {
        throw new LedgerRejection(
          "LINE_AMOUNT_INVALID",
          `Line ${index + 1}: a ${baseCurrency} line must have equal transaction and functional amounts`,
          index,
        );
      }
    } else if (!(Number(fxRate) > 0)) {
      // The kernel does not fetch or recompute FX (S4) — it only insists the
      // document did the conversion and showed its working.
      throw new LedgerRejection(
        "FX_RATE_INVALID",
        `Line ${index + 1}: a ${txnCurrency} line on ${baseCurrency} books needs a positive FX rate`,
        index,
      );
    }

    return {
      accountId: line.accountId,
      debitMinor,
      creditMinor,
      txnCurrency,
      txnAmountMinor,
      functionalCurrency: baseCurrency,
      functionalAmountMinor,
      fxRate,
      fxRateId: line.fxRateId ?? null,
      partyId: line.partyId ?? null,
      taxCodeId: line.taxCodeId ?? null,
      taxComponent: line.taxComponent ?? null,
      dimensionBranchId: line.dimensionBranchId ?? null,
      dimensionProjectId: line.dimensionProjectId ?? null,
      dimensionCostCenterId: line.dimensionCostCenterId ?? null,
      dimensionValues: line.dimensionValues ?? null,
      description: line.description ?? null,
    };
  });
}

/** Zero tolerance. Rounding belongs to the document layer, not here (M2). */
export function assertBalanced(lines: readonly NormalizedLine[]): void {
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    debit += line.debitMinor;
    credit += line.creditMinor;
  }
  if (debit !== credit) {
    throw new LedgerRejection(
      "UNBALANCED",
      `Journal does not balance: debits ${debit}, credits ${credit}, difference ${debit - credit}`,
      undefined,
      { totalDebitMinor: debit, totalCreditMinor: credit },
    );
  }
}

/** The original's lines with the sides swapped; everything else about each line is carried over. */
export function mirrorLines(original: PostedJournal): PostJournalLineCommand[] {
  return original.lines.map((line) => ({
    accountId: line.accountId,
    debitMinor: line.creditMinor,
    creditMinor: line.debitMinor,
    txnCurrency: line.txnCurrency,
    txnAmountMinor: line.txnAmountMinor,
    functionalAmountMinor: line.functionalAmountMinor,
    fxRate: line.fxRate,
    description: `Reverses ${original.journalNumber}`,
  }));
}
