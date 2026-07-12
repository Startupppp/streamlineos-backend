import { Module } from "@nestjs/common";
import { OverviewController } from "./overview.controller";
import { StatementReportsController } from "./statement-reports.controller";
import { AnalyticsReportsController } from "./analytics-reports.controller";
import { CatalogController } from "./catalog.controller";
import { OverviewService } from "./overview.service";
import { StatementReportsService } from "./statement-reports.service";
import { AnalyticsReportsService } from "./analytics-reports.service";

@Module({
  controllers: [
    OverviewController,
    StatementReportsController,
    AnalyticsReportsController,
    CatalogController,
  ],
  providers: [
    OverviewService,
    StatementReportsService,
    AnalyticsReportsService,
  ],
})
export class FinanceReportsModule {}
