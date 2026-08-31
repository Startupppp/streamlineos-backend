import { Module } from "@nestjs/common";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { OverviewController } from "./overview.controller";
import { StatementReportsController } from "./statement-reports.controller";
import { AnalyticsReportsController } from "./analytics-reports.controller";
import { CatalogController } from "./catalog.controller";
import { InsightsController } from "./insights.controller";
import { FinanceReportExportController } from "./finance-report-export.controller";
import { OverviewService } from "./overview.service";
import { StatementReportsService } from "./statement-reports.service";
import { AnalyticsReportsService } from "./analytics-reports.service";
import { InsightsService } from "./insights.service";
import { InsightsFindersService } from "./insights-finders.service";
import { FinanceReportExportService } from "./finance-report-export.service";
import { FinanceReportExportWorkerService } from "./finance-report-export-worker.service";
import { FinanceReportExportRequestedConsumer } from "./finance-report-export.consumer";

@Module({
  imports: [OutboxModule],
  controllers: [
    OverviewController,
    StatementReportsController,
    AnalyticsReportsController,
    CatalogController,
    InsightsController,
    FinanceReportExportController,
  ],
  providers: [
    OverviewService,
    StatementReportsService,
    AnalyticsReportsService,
    InsightsFindersService,
    InsightsService,
    FinanceReportExportService,
    FinanceReportExportWorkerService,
    FinanceReportExportRequestedConsumer,
  ],
})
export class FinanceReportsModule {}
