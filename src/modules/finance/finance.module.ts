import { Module } from "@nestjs/common";
import { FinanceApModule } from "./ap/finance-ap.module";
import { FinanceArModule } from "./ar/finance-ar.module";
import { FinanceAssetsModule } from "./assets/finance-assets.module";
import { FinanceBankingModule } from "./banking/finance-banking.module";
import { FinanceControlsModule } from "./controls/finance-controls.module";
import { FinanceExpensesModule } from "./expenses/finance-expenses.module";
import { FinancePlanningModule } from "./planning/finance-planning.module";
import { FinanceReportsModule } from "./reports/finance-reports.module";
import { FinanceTaxModule } from "./tax/finance-tax.module";

const FINANCE_MODULES = [
  FinanceApModule,
  FinanceArModule,
  FinanceAssetsModule,
  FinanceBankingModule,
  FinanceControlsModule,
  FinanceExpensesModule,
  FinancePlanningModule,
  FinanceReportsModule,
  FinanceTaxModule,
];

@Module({
  imports: FINANCE_MODULES,
  exports: FINANCE_MODULES,
})
export class FinanceModule {}
