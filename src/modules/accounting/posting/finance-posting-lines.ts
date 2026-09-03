import type { NewJournalLine } from "../../../db/schema/accounting/accounting";
import type { PostJournalLine } from "../core/finance-posting.types";
import { allocateDecimal, assertDebitsEqualsCredits, formatDecimal } from "../core/money.util";

export interface BuildJournalLinesInput {
  entryId: number;
  orgId: string;
  /** The currency the amounts on `lines` are quoted in. */
  entryCurrency: string;
  /** The org's book currency, from `accounting_settings.base_currency`. */
  baseCurrency: string;
  exchangeRate: string | null;
  /**
   * The entry's debit total already converted to `baseCurrency`, major units at
   * scale 4. Ignored when the entry is already in base currency.
   */
  entryBaseTotal: string;
  lines: ReadonlyArray<PostJournalLine & { resolvedAccountId: number }>;
}

/**
 * Build the `journal_lines` rows for one entry, and assert the entry balances in
 * the org's BASE currency before any of them is written.
 *
 * Two units live on every row. `debit`/`credit` are the amounts in
 * `entryCurrency`; `base_debit`/`base_credit` are the same amounts in
 * `baseCurrency`, and are NULL when the two currencies are the same. Every
 * statement, GL balance and report reads `COALESCE(base_debit, debit)`
 * (`core/journal-base-amount.ts`), so it is the BASE pair that has to balance —
 * and `assertDebitsEqualsCredits` at the top of `postJournal` only ever saw the
 * transaction pair.
 *
 * The base amounts are therefore ALLOCATED from the single converted total
 * rather than converted line by line. A per-line `multiplyDecimals` rounds each
 * line half-up independently, and the sum of the rounded parts is not the
 * rounded sum: debits of 100.0001 + 100.0001 against a credit of 200.0002 at
 * 83.5 convert to 16700.0168 of base debits against 16700.0167 of base credits.
 * That is a permanently unbalanced POSTED entry, and `journal_entries` and
 * `journal_lines` carry zero CHECK constraints and no balance trigger to catch
 * it. `allocateDecimal` distributes by largest remainder, so each side sums to
 * `entryBaseTotal` to the last unit of scale.
 */
export function buildJournalLineRows(input: BuildJournalLinesInput): NewJournalLine[] {
  const { entryId, orgId, entryCurrency, baseCurrency, exchangeRate, entryBaseTotal, lines } = input;
  const isForeign = entryCurrency !== baseCurrency;

  // Transaction-currency amounts, major units at scale 4.
  const txnDebits = lines.map((line) => formatDecimal(line.debit ?? "0"));
  const txnCredits = lines.map((line) => formatDecimal(line.credit ?? "0"));

  // Base-currency amounts, major units at scale 4; null when there is nothing to convert.
  const baseDebits = isForeign && exchangeRate ? allocateDecimal(entryBaseTotal, txnDebits) : null;
  const baseCredits = isForeign && exchangeRate ? allocateDecimal(entryBaseTotal, txnCredits) : null;

  const rows: NewJournalLine[] = lines.map((line, idx) => ({
    entryId,
    accountId: line.resolvedAccountId,
    orgId,
    debit: txnDebits[idx] ?? "0.0000",
    credit: txnCredits[idx] ?? "0.0000",
    description: line.description ?? null,
    lineOrder: idx,
    currency: isForeign ? entryCurrency : null,
    exchangeRate: exchangeRate ?? null,
    baseDebit: baseDebits?.[idx] ?? null,
    baseCredit: baseCredits?.[idx] ?? null,
    clientId: line.clientId ?? null,
    vendorId: line.vendorId ?? null,
    projectId: line.projectId ?? null,
    departmentId: line.departmentId ?? null,
    employeeId: line.employeeId ?? null,
    taxCodeId: line.taxCodeId ?? null,
    dimensionValues: line.dimensionValues ?? null,
  }));

  // Asserted through exactly the COALESCE the readers use, so the invariant
  // checked here is the invariant the trial balance depends on.
  assertDebitsEqualsCredits(
    rows.map((row) => ({
      debit: row.baseDebit ?? row.debit,
      credit: row.baseCredit ?? row.credit,
    })),
  );

  return rows;
}
