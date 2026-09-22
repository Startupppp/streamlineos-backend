import { Module } from "@nestjs/common";
import { HrAnalyticsPlusModule } from "../analytics-plus/hr-analytics-plus.module";
import { HrCasesModule } from "../cases/hr-cases.module";
import { HrConfigModule } from "../config/hr-config.module";
import { HrInterviewsModule } from "../interviews/hr-interviews.module";
import { HrLifecycleModule } from "../lifecycle/hr-lifecycle.module";
import { HrPerformanceModule } from "../performance/hr-performance.module";
import { HrRecruitmentModule } from "../recruitment/hr-recruitment.module";
import { HrTimeModule } from "../time/hr-time.module";
import { HrWorkflowsModule } from "../workflows/hr-workflows.module";
import { EmploymentFactsModule } from "../../directory/employment-facts.module";
import { TimesheetsCoreModule } from "../../timesheets/core/timesheets-core.module";
import { HrHubController } from "./hr-hub.controller";
import { HrHubService } from "./hr-hub.service";
import { ManagerHomeController } from "./manager-home.controller";
import { ManagerHomeService } from "./manager-home.service";

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
    HrWorkflowsModule,
    EmploymentFactsModule,
    TimesheetsCoreModule,
  ],
  controllers: [HrHubController, ManagerHomeController],
  providers: [HrHubService, ManagerHomeService],
})
export class HrHubModule {}
