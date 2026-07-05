import { Module } from "@nestjs/common";
import { PayrollSetupModule } from "./setup/payroll-setup.module";
import { PayrollRunsModule } from "./runs/payroll-runs.module";
import { PayrollPayoutModule } from "./payout/payroll-payout.module";
import { PayrollInsightsModule } from "./insights/payroll-insights.module";
import { PayrollCalendarReminderScheduler } from "./insights/payroll-calendar-reminder.scheduler";

@Module({
  imports: [
    PayrollSetupModule,
    PayrollRunsModule,
    PayrollPayoutModule,
    PayrollInsightsModule,
  ],
  providers: [PayrollCalendarReminderScheduler],
})
export class PayrollModule {}
