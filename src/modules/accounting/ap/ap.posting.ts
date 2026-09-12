import { convert, money } from "../kernel/money";
import type { PostJournalLineCommand } from "../kernel/ledger.types";

/**
 * A posting instruction in **document currency**, before conversion.
 *
 * AP builds these, `toJournalLines` turns them into the kernel's command shape,
 * and `LedgerService` is still the only thing that writes a journal line.
 */
export interface JournalDraftLine {
  accountId: string;
  side: "debit" | "credit";
  /** Document (transaction) currency, minor units. Zero lines are dropped. */
  amountMinor: number;
  description?: string;
  partyId?: string;
  taxCodeId?: string;
  taxComponent?: string;
  dimensionProjectId?: number;
  dimensionCostCenterId?: string;
}

export type PostingSide = "debit" | "credit";

/** A debit note is a bill with every side flipped; nothing else differs. */
export function flip(side: PostingSide): PostingSide {
  return side === "debit" ? "credit" : "debit";
}

export function draft(
  accountId: string,
  side: PostingSide,
  amountMinor: number,
  extra: Omit<JournalDraftLine, "accountId" | "side" | "amountMinor"> = {},
): JournalDraftLine {
  // A negative amount is the same posting on the other side — normalising here
  // means callers never have to reason about sign, only about direction.
  if (amountMinor < 0) {
    return { accountId, side: flip(side), amountMinor: -amountMinor, ...extra };
  }
  return { accountId, side, amountMinor, ...extra };
}

export interface ToJournalLinesOptions {
  drafts: readonly JournalDraftLine[];
  /** The document's currency. */
  currency: string;
  /** The book's base currency, which every debit and credit is measured in. */
  functionalCurrency: string;
  /** Multiplies transaction into functional. `"1"` for a same-currency book. */
  fxRate: string;
  /** Absorbs any residual so the journal balances at zero tolerance. */
  roundingAccountId: string;
  /**
   * A document-level rounding adjustment the tax pack asked for, in document
   * currency. Positive means the gross was rounded up, so the extra sits on the
   * debit side of a bill.
   */
  roundingMinor?: number;
  roundingDescription?: string;
}

/**
 * Convert drafts into kernel commands and make them balance exactly.
 *
 * Two things can leave a foreign-currency journal a minor unit out even when
 * the document is internally consistent: a pack that rounds the gross, and
 * per-line FX conversion where the parts no longer sum to the converted whole.
 * Both land on the `rounding` account as a **base-currency** line, because the
 * kernel balances in functional units and refuses anything else (PRD 01 M2).
 */
export function toJournalLines(options: ToJournalLinesOptions): PostJournalLineCommand[] {
  const {
    drafts,
    currency,
    functionalCurrency,
    roundingAccountId,
    roundingMinor = 0,
    roundingDescription,
  } = options;
  const sameCurrency = currency === functionalCurrency;
  const fxRate = sameCurrency ? "1" : options.fxRate;

  const all = [...drafts];
  if (roundingMinor !== 0) {
    all.push(
      draft(roundingAccountId, "debit", roundingMinor, {
        description: roundingDescription ?? "Rounding adjustment",
      }),
    );
  }

  const lines: PostJournalLineCommand[] = [];
  let debitTotal = 0;
  let creditTotal = 0;

  for (const item of all) {
    if (item.amountMinor === 0) continue;
    const functionalAmountMinor = sameCurrency
      ? item.amountMinor
      : convert(money(item.amountMinor, currency), functionalCurrency, fxRate).minor;
    if (functionalAmountMinor === 0) continue;

    if (item.side === "debit") debitTotal += functionalAmountMinor;
    else creditTotal += functionalAmountMinor;

    lines.push({
      accountId: item.accountId,
      debitMinor: item.side === "debit" ? functionalAmountMinor : undefined,
      creditMinor: item.side === "credit" ? functionalAmountMinor : undefined,
      txnCurrency: currency,
      txnAmountMinor: item.amountMinor,
      functionalAmountMinor,
      fxRate,
      partyId: item.partyId,
      taxCodeId: item.taxCodeId,
      taxComponent: item.taxComponent,
      dimensionProjectId: item.dimensionProjectId,
      dimensionCostCenterId: item.dimensionCostCenterId,
      description: item.description,
    });
  }

  const residual = debitTotal - creditTotal;
  if (residual !== 0) {
    const amount = Math.abs(residual);
    lines.push({
      accountId: roundingAccountId,
      debitMinor: residual < 0 ? amount : undefined,
      creditMinor: residual > 0 ? amount : undefined,
      // Always a base-currency line: the residual only exists in functional
      // units, so pretending it has a transaction amount would be a lie.
      txnCurrency: functionalCurrency,
      txnAmountMinor: amount,
      functionalAmountMinor: amount,
      fxRate: "1",
      description: "Currency rounding difference",
    });
  }

  return lines;
}
