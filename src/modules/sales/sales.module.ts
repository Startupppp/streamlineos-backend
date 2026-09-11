import { Module } from "@nestjs/common";
import { SalesController } from "./sales.controller";
import { SalesService } from "./sales.service";
import { SalesPlaybookService } from "./sales-playbook.service";
import { SalesDashboardService } from "./sales-dashboard.service";
import { SalesAnalyticsService } from "./sales-analytics.service";

@Module({
  controllers: [SalesController],
  providers: [SalesService, SalesPlaybookService, SalesDashboardService, SalesAnalyticsService],
})
export class SalesModule {}
