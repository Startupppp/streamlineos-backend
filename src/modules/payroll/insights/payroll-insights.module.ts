import { Module } from "@nestjs/common";
import { HrPayrollModule } from "../hr-payroll/hr-payroll.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { AiModule } from "../../ai/core/ai.module";
import { PayrollInsightsReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { JournalController } from "./journal.controller";
import { JournalService } from "./journal.service";
import { JournalOutboxController } from "./journal-outbox.controller";
import { JournalOutboxService } from "./journal-outbox.service";
import { PeriodReconciliationService } from "./period-reconciliation.service";
import { ManagerInboxController } from "./manager-inbox.controller";
import { ManagerInboxService } from "./manager-inbox.service";
import { TeamRewardsService } from "./team-rewards.service";
import { PayAnalyticsController } from "./pay-analytics.controller";
import { AccountingMappingsController } from "./accounting-mappings.controller";
import { AccountingMappingsService } from "./accounting-mappings.service";
import { PayrollInsightsCalendarController } from "./calendar.controller";
import { CalendarService } from "./calendar.service";
import { TaxWindowsController } from "./tax-windows.controller";
import { TaxWindowsService } from "./tax-windows.service";
import { TaxAdminController } from "./tax-admin.controller";
import { TaxAdminService } from "./tax-admin.service";
import { PayrollInsightsFnfController } from "./fnf.controller";
import { FnfInsightsService } from "./fnf.service";
import { EssController } from "./ess.controller";
import { EssService } from "./ess.service";
import { EssSelfServiceService } from "./ess-self-service.service";
import { PayrollNotificationsService } from "./payroll-notifications.service";
import { PayrollAiExplainController } from "./payroll-ai-explain.controller";
import { PayrollAiExplainService } from "./payroll-ai-explain.service";
import { EmploymentFactsModule } from "../../directory/employment-facts.module";

@Module({
  imports: [EmploymentFactsModule, HrPayrollModule, NotificationsModule, AiModule],
  controllers: [
    PayrollInsightsReportsController,
    JournalController,
    JournalOutboxController,
    AccountingMappingsController,
    PayrollInsightsCalendarController,
    TaxWindowsController,
    TaxAdminController,
    PayrollInsightsFnfController,
    EssController,
    ManagerInboxController,
    PayAnalyticsController,
    PayrollAiExplainController,
  ],
  providers: [
    ReportsService,
    JournalService,
    JournalOutboxService,
    PeriodReconciliationService,
    ManagerInboxService,
    TeamRewardsService,
    AccountingMappingsService,
    CalendarService,
    TaxWindowsService,
    TaxAdminService,
    FnfInsightsService,
    EssService,
    EssSelfServiceService,
    PayrollNotificationsService,
    PayrollAiExplainService,
  ],
  exports: [PayrollNotificationsService, JournalOutboxService, PeriodReconciliationService],
})
export class PayrollInsightsModule {}
