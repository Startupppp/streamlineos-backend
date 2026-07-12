import { Module } from "@nestjs/common";
import { AccountingModule } from "../accounting/accounting.module";
import { AccountingSettingsController } from "./accounting-settings.controller";
import { AccountingSettingsService } from "./accounting-settings.service";
import { SystemAccountsController } from "./system-accounts.controller";
import { SystemAccountsService } from "./system-accounts.service";
import { CoaController } from "./coa.controller";
import { CoaService } from "./coa.service";
import { OpeningBalancesController } from "./opening-balances.controller";
import { OpeningBalancesService } from "./opening-balances.service";

@Module({
  imports: [AccountingModule],
  controllers: [
    AccountingSettingsController,
    SystemAccountsController,
    CoaController,
    OpeningBalancesController,
  ],
  providers: [
    AccountingSettingsService,
    SystemAccountsService,
    CoaService,
    OpeningBalancesService,
  ],
  exports: [AccountingSettingsService, SystemAccountsService],
})
export class AccountingSettingsModule {}
