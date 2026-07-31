import { Module } from "@nestjs/common";
import { AccountingModule } from "./core/accounting.module";
import { AccountingAiModule } from "./ai/accounting-ai.module";
import { AccountingGlModule } from "./gl/accounting-gl.module";
import { AccountingSettingsModule } from "./settings/accounting-settings.module";

const ACCOUNTING_MODULES = [AccountingModule, AccountingAiModule, AccountingGlModule, AccountingSettingsModule];

@Module({
  imports: ACCOUNTING_MODULES,
  exports: ACCOUNTING_MODULES,
})
export class AccountingRootModule {}
