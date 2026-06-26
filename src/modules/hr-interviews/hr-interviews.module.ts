import { Module } from "@nestjs/common";
import { HrInterviewsController } from "./hr-interviews.controller";
import { HrInterviewersController } from "./hr-interviewers.controller";
import { HrHiringFlowsController } from "./hr-hiring-flows.controller";
import { HrOffersController } from "./hr-offers.controller";
import { HrScorecardsController } from "./hr-scorecards.controller";
import { HrRecruitmentReportsController } from "./hr-recruitment-reports.controller";
import { HrInterviewsService } from "./hr-interviews.service";
import { HrInterviewersService } from "./hr-interviewers.service";
import { HrHiringFlowsService } from "./hr-hiring-flows.service";
import { HrOffersService } from "./hr-offers.service";
import { HrScorecardsService } from "./hr-scorecards.service";
import { HrRecruitmentReportsService } from "./hr-recruitment-reports.service";

@Module({
  controllers: [
    HrInterviewsController,
    HrInterviewersController,
    HrHiringFlowsController,
    HrOffersController,
    HrScorecardsController,
    HrRecruitmentReportsController,
  ],
  providers: [
    HrInterviewsService,
    HrInterviewersService,
    HrHiringFlowsService,
    HrOffersService,
    HrScorecardsService,
    HrRecruitmentReportsService,
  ],
})
export class HrInterviewsModule {}
