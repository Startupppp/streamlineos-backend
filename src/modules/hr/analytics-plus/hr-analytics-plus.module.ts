import { Module } from "@nestjs/common";
import { HrAnalyticsPlusController } from "./hr-analytics-plus.controller";
import { HrAnalyticsPlusService } from "./hr-analytics-plus.service";
import { HrCommandCenterAnalyticsService } from "./hr-command-center-analytics.service";

@Module({
  controllers: [HrAnalyticsPlusController],
  providers: [HrAnalyticsPlusService, HrCommandCenterAnalyticsService],
  exports: [HrAnalyticsPlusService],
})
export class HrAnalyticsPlusModule {}
