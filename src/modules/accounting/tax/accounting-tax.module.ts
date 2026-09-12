import { Module } from "@nestjs/common";
import { AccountingKernelModule } from "../kernel/accounting-kernel.module";
import { TaxEngineRegistry } from "./tax-engine.registry";
import { TaxService } from "./tax.service";

/**
 * Tax determination. Pure engines plus the rate tables they read.
 *
 * Exported because AR and AP both call `determine`; nothing here writes to the
 * ledger, so it can be swapped or extended without touching the kernel.
 */
@Module({
  imports: [AccountingKernelModule],
  providers: [TaxEngineRegistry, TaxService],
  exports: [TaxEngineRegistry, TaxService],
})
export class AccountingTaxModule {}
