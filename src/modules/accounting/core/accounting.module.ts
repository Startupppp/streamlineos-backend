import { Module } from "@nestjs/common";
import { AccountingAdaptersModule } from "../adapters/accounting-adapters.module";
import { AccountingKernelModule } from "../kernel/accounting-kernel.module";

/**
 * Compatibility module for Payroll, which imports `AccountingModule` from this
 * path and is not ours to edit. The legacy ledger this module used to assemble
 * is gone: payroll posts through `PostingCommandService` (the adapters) and
 * resolves its book through `BooksService` (the kernel), so this re-exports
 * exactly those two modules and registers nothing of its own.
 */
@Module({
  imports: [AccountingAdaptersModule, AccountingKernelModule],
  exports: [AccountingAdaptersModule, AccountingKernelModule],
})
export class AccountingModule {}
