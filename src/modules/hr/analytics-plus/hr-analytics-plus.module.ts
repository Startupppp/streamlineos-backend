import { Module } from "@nestjs/common";
import { HrAnalyticsPlusController } from "./hr-analytics-plus.controller";
import { HrAnalyticsPlusService } from "./hr-analytics-plus.service";

@Module({
  controllers: [HrAnalyticsPlusController],
  providers: [HrAnalyticsPlusService],
  exports: [HrAnalyticsPlusService],
})
export class HrAnalyticsPlusModule {}
