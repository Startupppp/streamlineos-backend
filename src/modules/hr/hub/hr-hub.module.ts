import { Module } from "@nestjs/common";
import { HrAnalyticsPlusModule } from "../analytics-plus/hr-analytics-plus.module";
import { HrCasesModule } from "../cases/hr-cases.module";
import { HrConfigModule } from "../config/hr-config.module";
import { HrInterviewsModule } from "../interviews/hr-interviews.module";
import { HrLifecycleModule } from "../lifecycle/hr-lifecycle.module";
import { HrPerformanceModule } from "../performance/hr-performance.module";
import { HrRecruitmentModule } from "../recruitment/hr-recruitment.module";
import { HrTimeModule } from "../time/hr-time.module";
import { HrHubController } from "./hr-hub.controller";
import { HrHubService } from "./hr-hub.service";

@Module({
  imports: [
    HrAnalyticsPlusModule,
    HrCasesModule,
    HrConfigModule,
    HrInterviewsModule,
    HrLifecycleModule,
    HrPerformanceModule,
    HrRecruitmentModule,
    HrTimeModule,
  ],
  controllers: [HrHubController],
  providers: [HrHubService],
})
export class HrHubModule {}
