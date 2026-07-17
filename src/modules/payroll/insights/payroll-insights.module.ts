import { Module } from "@nestjs/common";
import { HrPayrollModule } from "../../hr-payroll/hr-payroll.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { AiModule } from "../../ai/ai.module";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { JournalController } from "./journal.controller";
import { JournalService } from "./journal.service";
import { AccountingMappingsController } from "./accounting-mappings.controller";
import { AccountingMappingsService } from "./accounting-mappings.service";
import { CalendarController } from "./calendar.controller";
import { CalendarService } from "./calendar.service";
import { TaxWindowsController } from "./tax-windows.controller";
import { TaxWindowsService } from "./tax-windows.service";
import { TaxAdminController } from "./tax-admin.controller";
import { FnfController } from "./fnf.controller";
import { FnfInsightsService } from "./fnf.service";
import { EssController } from "./ess.controller";
import { EssService } from "./ess.service";
import { PayrollNotificationsService } from "./payroll-notifications.service";
import { PayrollAiExplainController } from "./payroll-ai-explain.controller";
import { PayrollAiExplainService } from "./payroll-ai-explain.service";

@Module({
  imports: [HrPayrollModule, NotificationsModule, AiModule],
  controllers: [
    ReportsController,
    JournalController,
    AccountingMappingsController,
    CalendarController,
    TaxWindowsController,
    TaxAdminController,
    FnfController,
    EssController,
    PayrollAiExplainController,
  ],
  providers: [
    ReportsService,
    JournalService,
    AccountingMappingsService,
    CalendarService,
    TaxWindowsService,
    FnfInsightsService,
    EssService,
    PayrollNotificationsService,
    PayrollAiExplainService,
  ],
  exports: [PayrollNotificationsService],
})
export class PayrollInsightsModule {}
