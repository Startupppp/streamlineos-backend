import { sql } from "drizzle-orm";
import { journalLines } from "../../../db/schema";

/**
 * The base-currency amount of a journal line.
 *
 * `journal_lines.debit`/`credit` are denominated in the ENTRY's currency, not the
 * org's. `base_debit`/`base_credit` carry the converted amount and are written
 * only when the two differ (`finance-posting.service.ts:213-219`), so they are
 * NULL for the overwhelming majority of rows — every entry already written in
 * base currency. `COALESCE(base_debit, debit)` is therefore the base amount for
 * BOTH shapes, and needs no join to a rate table.
 *
 * Every trial balance, balance sheet, P&L, cash-flow figure, GL balance and
 * budget-actual is a base-currency number. Each one must read through here.
 * Summing the raw column instead adds USD 100 to INR 40 and publishes 140 —
 * proven against a real ledger in `__tests__/base-currency-statements.db.spec.ts`.
 *
 * The two reads that must NOT use this are the ones that are deliberately in the
 * entry's own currency: the journal-entry detail view, and the reversal builder,
 * which mirrors the original line for line in the currency it was written in.
 *
 * Unit for both: the org's base currency, major units, `numeric(18,4)`.
 */
export const baseDebitAmount = sql<string>`coalesce(${journalLines.baseDebit}, ${journalLines.debit})`;
export const baseCreditAmount = sql<string>`coalesce(${journalLines.baseCredit}, ${journalLines.credit})`;
