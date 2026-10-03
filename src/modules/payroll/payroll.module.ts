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
import { AvScannerModule } from "../../common/security/av-scanner.module";
import { PayrollForm16DocumentsController } from "./filings/form16-documents.controller";
import { EssForm16Controller } from "./insights/ess-form16.controller";
import { Form16DocumentsService } from "./filings/form16-documents.service";

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
    AvScannerModule,
  ],
  controllers: [PayrollEntitiesController, PayrollFilingsController, PayrollJobsController, PayrollForm16DocumentsController, EssForm16Controller],
  providers: [
    PayrollCalendarReminderScheduler,
    PayrollFilingsService,
    PayrollFilingsExportJobService,
    Form16DocumentsService,
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
