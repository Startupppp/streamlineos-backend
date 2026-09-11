/**
 * Compatibility shim. Not part of the schema barrel, deliberately.
 *
 * This path was the legacy ledger (`ledger_accounts`, `journal_entries`,
 * `journal_lines`), deleted by the accounting rewrite: the `gl_*` kernel is the
 * ledger now, and only `LedgerService` writes it.
 *
 * Main's payroll schema (`payroll/claims-and-settlements.ts`, fenced) still
 * imports `journalEntries` and `ledgerAccounts` from here, for two composite
 * foreign keys and one relation on the expense tables. Those columns mean "the
 * account an expense category books to" and "the journal an expense was posted
 * as", which after the rewrite are a `gl_accounts` row and a `gl_journals` row.
 * The integration branch's own version of that file pointed them at `glAccounts`
 * and `glJournals`; this keeps that meaning without editing main's file.
 *
 * Only the two legacy names payroll uses are exported, and only as aliases. Do
 * not add this file to `./index.ts`: it would register the same two tables in the
 * drizzle schema a second time under different keys. New code imports
 * `glAccounts` / `glJournals` from `./gl-kernel`.
 */
export { glAccounts as ledgerAccounts, glJournals as journalEntries } from "./gl-kernel";
