import { Module } from "@nestjs/common";
import { NotificationsModule } from "../../notifications/notifications.module";
import { AutomationModule } from "../../automation/automation.module";
import { HrInterviewsController } from "./hr-interviews.controller";
import { HrInterviewersController } from "./hr-interviewers.controller";
import { HrHiringFlowsController } from "./hr-hiring-flows.controller";
import { HrOffersController } from "./hr-offers.controller";
import { HrScorecardsController } from "./hr-scorecards.controller";
import { HrRecruitmentReportsController } from "./hr-recruitment-reports.controller";
import { HrInterviewSchedulingController } from "./hr-interview-scheduling.controller";
import { HrInterviewBookingController } from "./hr-interview-booking.controller";
import { EmployeeRecruitmentController } from "./employee-recruitment.controller";
import { HrInterviewsService } from "./hr-interviews.service";
import { HrInterviewersService } from "./hr-interviewers.service";
import { HrHiringFlowsService } from "./hr-hiring-flows.service";
import { HrOffersService } from "./hr-offers.service";
import { HrScorecardsService } from "./hr-scorecards.service";
import { HrRecruitmentReportsService } from "./hr-recruitment-reports.service";
import { HrInterviewSchedulingService } from "./hr-interview-scheduling.service";
import { HrInterviewResultsService } from "./hr-interview-results.service";
import { HrInterviewBookingService } from "./hr-interview-booking.service";
import { InterviewAvailabilityService } from "./calendar/interview-availability.service";
import { InterviewTranscriptService } from "./transcripts/interview-transcript.service";
import { InterviewTranscriptController } from "./transcripts/interview-transcript.controller";
import { ProviderCredentialsService } from "../recruitment/integrations/provider-credentials.service";
import { ChatNotifyService } from "../recruitment/chat-notify/chat-notify.service";

@Module({
  imports: [NotificationsModule, AutomationModule],
  controllers: [
    EmployeeRecruitmentController,
    HrInterviewsController,
    HrInterviewersController,
    HrHiringFlowsController,
    HrOffersController,
    HrScorecardsController,
    HrRecruitmentReportsController,
    HrInterviewSchedulingController,
    HrInterviewBookingController,
    InterviewTranscriptController,
  ],
  providers: [
    HrInterviewsService,
    HrInterviewersService,
    HrHiringFlowsService,
    HrOffersService,
    HrScorecardsService,
    HrRecruitmentReportsService,
    HrInterviewSchedulingService,
    HrInterviewResultsService,
    HrInterviewBookingService,
    InterviewAvailabilityService,
    InterviewTranscriptService,
    /**
     * Provided here rather than imported from HrRecruitmentModule: importing
     * that module for one service would pull its whole controller set into
     * this one's dependency graph. The service is stateless and reads the
     * shared `candidate_sources` credential store.
     */
    ProviderCredentialsService,
    ChatNotifyService,
  ],
  exports: [HrInterviewsService, HrRecruitmentReportsService],
})
export class HrInterviewsModule {}
