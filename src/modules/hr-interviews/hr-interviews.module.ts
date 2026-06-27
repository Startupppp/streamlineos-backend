import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { AutomationModule } from "../automation/automation.module";
import { GoogleCalendarModule } from "../google-calendar/google-calendar.module";
import { HrInterviewsController } from "./hr-interviews.controller";
import { HrInterviewersController } from "./hr-interviewers.controller";
import { HrHiringFlowsController } from "./hr-hiring-flows.controller";
import { HrOffersController } from "./hr-offers.controller";
import { HrScorecardsController } from "./hr-scorecards.controller";
import { HrRecruitmentReportsController } from "./hr-recruitment-reports.controller";
import { HrInterviewSchedulingController } from "./hr-interview-scheduling.controller";
import { HrInterviewBookingController } from "./hr-interview-booking.controller";
import { HrInterviewsService } from "./hr-interviews.service";
import { HrInterviewersService } from "./hr-interviewers.service";
import { HrHiringFlowsService } from "./hr-hiring-flows.service";
import { HrOffersService } from "./hr-offers.service";
import { HrScorecardsService } from "./hr-scorecards.service";
import { HrRecruitmentReportsService } from "./hr-recruitment-reports.service";
import { HrInterviewSchedulingService } from "./hr-interview-scheduling.service";
import { HrInterviewResultsService } from "./hr-interview-results.service";
import { HrInterviewBookingService } from "./hr-interview-booking.service";

@Module({
  imports: [NotificationsModule, AutomationModule, GoogleCalendarModule],
  controllers: [
    HrInterviewsController,
    HrInterviewersController,
    HrHiringFlowsController,
    HrOffersController,
    HrScorecardsController,
    HrRecruitmentReportsController,
    HrInterviewSchedulingController,
    HrInterviewBookingController,
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
  ],
})
export class HrInterviewsModule {}
