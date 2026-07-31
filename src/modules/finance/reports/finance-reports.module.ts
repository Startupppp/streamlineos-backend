import { Module } from "@nestjs/common";
import { OverviewController } from "./overview.controller";
import { StatementReportsController } from "./statement-reports.controller";
import { AnalyticsReportsController } from "./analytics-reports.controller";
import { CatalogController } from "./catalog.controller";
import { InsightsController } from "./insights.controller";
import { OverviewService } from "./overview.service";
import { StatementReportsService } from "./statement-reports.service";
import { AnalyticsReportsService } from "./analytics-reports.service";
import { InsightsService } from "./insights.service";
import { InsightsFindersService } from "./insights-finders.service";

@Module({
  controllers: [
    OverviewController,
    StatementReportsController,
    AnalyticsReportsController,
    CatalogController,
    InsightsController,
  ],
  providers: [
    OverviewService,
    StatementReportsService,
    AnalyticsReportsService,
    InsightsFindersService,
    InsightsService,
  ],
})
export class FinanceReportsModule {}
