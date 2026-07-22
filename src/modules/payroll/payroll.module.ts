import { Module } from "@nestjs/common";
import { PayrollSetupModule } from "./setup/payroll-setup.module";
import { PayrollRunsModule } from "./runs/payroll-runs.module";
import { PayrollPayoutModule } from "./payout/payroll-payout.module";
import { PayrollInsightsModule } from "./insights/payroll-insights.module";
import { PayrollCalendarReminderScheduler } from "./insights/payroll-calendar-reminder.scheduler";
import { PayrollEntitiesController } from "./entities/entities.controller";
import { PayrollEntitiesService } from "./entities/entities.service";
import { PayrollFilingsController } from "./filings/filings.controller";
import { PayrollFilingsService } from "./filings/filings.service";
import { PayrollJobsService } from "./jobs/payroll-jobs.service";
import { PayrollJobsController } from "./jobs/jobs.controller";
import { PayrollJobsWorkerService } from "./jobs/payroll-jobs-worker.service";

@Module({
  imports: [
    PayrollSetupModule,
    PayrollRunsModule,
    PayrollPayoutModule,
    PayrollInsightsModule,
  ],
  controllers: [PayrollEntitiesController, PayrollFilingsController, PayrollJobsController],
  providers: [
    PayrollCalendarReminderScheduler,
    PayrollEntitiesService,
    PayrollFilingsService,
    PayrollJobsService,
    PayrollJobsWorkerService,
  ],
  exports: [PayrollJobsService, PayrollEntitiesService, PayrollFilingsService, PayrollJobsWorkerService],
})
export class PayrollModule {}
