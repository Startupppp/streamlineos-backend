import { Module } from "@nestjs/common";
import { AccountingModule } from "../core/accounting.module";
import { AccountingSettingsController } from "./accounting-settings.controller";
import { AccountingSettingsService } from "./accounting-settings.service";
import { SystemAccountsController } from "./system-accounts.controller";
import { SystemAccountsService } from "./system-accounts.service";
import { CoaController } from "./coa.controller";
import { CoaService } from "./coa.service";
import { OpeningBalancesController } from "./opening-balances.controller";
import { OpeningBalancesService } from "./opening-balances.service";
import { DimensionsController } from "./dimensions.controller";
import { DimensionsService } from "./dimensions.service";

@Module({
  imports: [AccountingModule],
  controllers: [
    AccountingSettingsController,
    SystemAccountsController,
    CoaController,
    OpeningBalancesController,
    DimensionsController,
  ],
  providers: [
    AccountingSettingsService,
    SystemAccountsService,
    CoaService,
    OpeningBalancesService,
    DimensionsService,
  ],
  exports: [AccountingSettingsService, SystemAccountsService],
})
export class AccountingSettingsModule {}
