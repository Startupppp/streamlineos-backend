import { Module } from "@nestjs/common";
import { AccountingKernelModule } from "./kernel/accounting-kernel.module";
import { AccountingTaxModule } from "./tax/accounting-tax.module";
import { AccountingSetupModule } from "./setup/accounting-setup.module";
import { AccountingComplianceModule } from "./compliance/accounting-compliance.module";
import { AccountingAdaptersModule } from "./adapters/accounting-adapters.module";
import { PartiesModule } from "./parties/parties.module";
import { ArModule } from "./ar/ar.module";
import { ApModule } from "./ap/ap.module";
import { BankingModule } from "./banking/banking.module";
// Aliased: the platform already has a `ReportsModule` registered in app.module.ts.
import { ReportsModule as AccountingReportsModule } from "./reports/reports.module";

/**
 * Accounting — a bounded context, layered so the dependency arrows only ever
 * point downward.
 *
 *   kernel            the ledger. Knows nothing about tax, documents or banks.
 *   packs + tax       determination. Pure; writes no journal.
 *   setup             turns the two on for an organisation.
 *   parties           customers and vendors, shared by AR and AP.
 *   ar / ap           source documents. They compute, freeze tax, and post.
 *   banking           cash as GL accounts, plus reconciliation.
 *   reports           reads journal lines and open items. No stored balances.
 *   compliance        e-invoicing state. Fields only in v1.
 *   adapters          the anti-corruption layer other modules talk through.
 *
 * The rule the whole thing rests on: **only `LedgerService` writes
 * `gl_journals` and `gl_journal_lines`**, and `adapters/ledger-boundary.spec.ts`
 * proves it structurally rather than by convention.
 */
const ACCOUNTING_MODULES = [
  AccountingKernelModule,
  AccountingTaxModule,
  AccountingSetupModule,
  AccountingComplianceModule,
  PartiesModule,
  ArModule,
  ApModule,
  BankingModule,
  AccountingReportsModule,
  AccountingAdaptersModule,
];

@Module({
  imports: ACCOUNTING_MODULES,
  exports: ACCOUNTING_MODULES,
})
export class AccountingRootModule {}
