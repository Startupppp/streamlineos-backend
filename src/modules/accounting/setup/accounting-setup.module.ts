import { Module } from "@nestjs/common";
import { AccountingKernelModule } from "../kernel/accounting-kernel.module";
import { AccountingTaxModule } from "../tax/accounting-tax.module";
import { AccountingSetupController } from "./accounting-setup.controller";
import { AccountingSetupService } from "./accounting-setup.service";
import { OpeningBalancesService } from "./opening-balances.service";

/**
 * Onboarding sits above the kernel and tax so the kernel keeps no dependency on
 * tax — the ledger must stay testable without a tax engine present.
 */
@Module({
  imports: [AccountingKernelModule, AccountingTaxModule],
  controllers: [AccountingSetupController],
  providers: [AccountingSetupService, OpeningBalancesService],
  exports: [AccountingSetupService, OpeningBalancesService],
})
export class AccountingSetupModule {}
