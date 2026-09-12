import { Module } from "@nestjs/common";
import { PackRegistry } from "../packs/pack.registry";
import { AccountingKernelController } from "./kernel.controller";
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
  /*
    There used to be an `APP_FILTER` here mapping `LedgerRejection` onto 409/404,
    and it never fired once. Nest tries global filters in REVERSE registration
    order; `APP_FILTER` providers are registered during module init and
    `main.ts` calls `useGlobalFilters(new AllExceptionsFilter())` afterwards, so
    the catch-all was always last and always won. Every locked period and
    unbalanced journal in AR, AP, banking and the inventory bridge answered
    `500 INTERNAL_ERROR`. `LedgerRejection` now carries its own status as an
    `HttpException`, which no filter ordering can undo — see `ledger.types.ts`.
  */
  providers: [...KERNEL_PROVIDERS],
  exports: KERNEL_PROVIDERS,
})
export class AccountingKernelModule {}
