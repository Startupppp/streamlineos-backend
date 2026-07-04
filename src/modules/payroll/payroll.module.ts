import { Module } from "@nestjs/common";
import { PayrollSetupModule } from "./setup/payroll-setup.module";
import { PayrollRunsModule } from "./runs/payroll-runs.module";
import { PayrollPayoutModule } from "./payout/payroll-payout.module";
import { PayrollInsightsModule } from "./insights/payroll-insights.module";

@Module({
  imports: [
    PayrollSetupModule,
    PayrollRunsModule,
    PayrollPayoutModule,
    PayrollInsightsModule,
  ],
})
export class PayrollModule {}
