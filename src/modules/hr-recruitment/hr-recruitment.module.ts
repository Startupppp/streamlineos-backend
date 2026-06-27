import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { AutomationModule } from "../automation/automation.module";
import { AiModule } from "../ai/ai.module";
import { RecruitmentCandidatesController } from "./recruitment-candidates.controller";
import { RecruitmentPipelineController } from "./recruitment-pipeline.controller";
import { RecruitmentCandidateRecordsController } from "./recruitment-candidate-records.controller";
import { RecruitmentOffersController } from "./recruitment-offers.controller";
import { RecruitmentJobsController } from "./recruitment-jobs.controller";
import { RecruitmentRecruitersController } from "./recruitment-recruiters.controller";
import { RecruitmentSourcingController } from "./recruitment-sourcing.controller";
import { RecruitmentAutomationController } from "./recruitment-automation.controller";
import { RecruitmentCandidatesService } from "./recruitment-candidates.service";
import { RecruitmentCandidateOpsService } from "./recruitment-candidate-ops.service";
import { RecruitmentPipelineService } from "./recruitment-pipeline.service";
import { RecruitmentCandidateRecordsService } from "./recruitment-candidate-records.service";
import { RecruitmentOffersService } from "./recruitment-offers.service";
import { RecruitmentJobsService } from "./recruitment-jobs.service";
import { RecruitmentRecruitersService } from "./recruitment-recruiters.service";
import { RecruitmentSourcingService } from "./recruitment-sourcing.service";
import { RecruitmentAutomationService } from "./recruitment-automation.service";
import { RecruitmentCandidateAiService } from "./recruitment-candidate-ai.service";

@Module({
  imports: [NotificationsModule, AutomationModule, AiModule],
  controllers: [
    RecruitmentCandidatesController,
    RecruitmentPipelineController,
    RecruitmentCandidateRecordsController,
    RecruitmentOffersController,
    RecruitmentJobsController,
    RecruitmentRecruitersController,
    RecruitmentSourcingController,
    RecruitmentAutomationController,
  ],
  providers: [
    RecruitmentCandidatesService,
    RecruitmentCandidateOpsService,
    RecruitmentPipelineService,
    RecruitmentCandidateRecordsService,
    RecruitmentOffersService,
    RecruitmentJobsService,
    RecruitmentRecruitersService,
    RecruitmentSourcingService,
    RecruitmentAutomationService,
    RecruitmentCandidateAiService,
  ],
})
export class HrRecruitmentModule {}
