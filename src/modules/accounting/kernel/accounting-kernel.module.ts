import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { PackRegistry } from "../packs/pack.registry";
import { AccountingKernelController } from "./kernel.controller";
import { LedgerRejectionFilter } from "./ledger-rejection.filter";
import { AccountsService } from "./accounts.service";
import { BooksService } from "./books.service";
import { FxService } from "./fx.service";
import { LedgerService } from "./ledger.service";
import { PeriodsService } from "./periods.service";
import { SequenceService } from "./sequence.service";

/**
 * The ledger kernel.
 *
 * Everything here is exported because every other accounting layer posts
 * through `LedgerService` and resolves accounts through `BooksService`. Nothing
 * outside this module may write `gl_journals` or `gl_journal_lines`.
 */
const KERNEL_PROVIDERS = [
  PackRegistry,
  SequenceService,
  BooksService,
  AccountsService,
  PeriodsService,
  LedgerService,
  FxService,
];

@Module({
  controllers: [AccountingKernelController],
  providers: [
    ...KERNEL_PROVIDERS,
    // Registered here rather than at each controller: `APP_FILTER` is global in
    // Nest wherever it is declared, and this filter only catches
    // `LedgerRejection`, so every document layer gets the same 409 without
    // having to remember to translate it.
    { provide: APP_FILTER, useClass: LedgerRejectionFilter },
  ],
  exports: KERNEL_PROVIDERS,
})
export class AccountingKernelModule {}
