import { Module } from "@nestjs/common";
import { PayrollSetupModule } from "./setup/payroll-setup.module";
import { PayrollRunsModule } from "./runs/payroll-runs.module";
import { PayrollPayoutModule } from "./payout/payroll-payout.module";
import { PayrollInsightsModule } from "./insights/payroll-insights.module";
import { PayrollCalendarReminderScheduler } from "./insights/payroll-calendar-reminder.scheduler";
import { PayrollEntitiesController } from "./entities/entities.controller";
import { PayrollEntitiesModule } from "./entities/payroll-entities.module";
import { PayrollFilingsController } from "./filings/filings.controller";
import { PayrollFilingsService } from "./filings/filings.service";
import { PayrollFilingsExportJobService } from "./filings/filings-export-job.service";
import { PayrollJobsService } from "./jobs/payroll-jobs.service";
import { PayrollJobsController } from "./jobs/jobs.controller";
import { PayrollJobsWorkerService } from "./jobs/payroll-jobs-worker.service";
import { DirectoryModule } from "../directory/directory.module";
import { EmploymentFactsModule } from "../directory/employment-facts.module";
import { PayrollTimesheetHandoffModule } from "./timesheet-handoff/payroll-timesheet-handoff.module";

@Module({
  imports: [
    EmploymentFactsModule,
    PayrollSetupModule,
    PayrollRunsModule,
    PayrollPayoutModule,
    PayrollInsightsModule,
    PayrollEntitiesModule,
    DirectoryModule,
    PayrollTimesheetHandoffModule,
  ],
  controllers: [PayrollEntitiesController, PayrollFilingsController, PayrollJobsController],
  providers: [
    PayrollCalendarReminderScheduler,
    PayrollFilingsService,
    PayrollFilingsExportJobService,
    PayrollJobsService,
    PayrollJobsWorkerService,
  ],
  exports: [
    PayrollJobsService,
    PayrollEntitiesModule,
    PayrollFilingsService,
    PayrollJobsWorkerService,
  ],
})
export class PayrollModule {}
