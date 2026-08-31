import { Module } from "@nestjs/common";
import { AutomationModule } from "../../automation/automation.module";
import { HrAutomationsModule } from "../automations/hr-automations.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { PerformanceController } from "./performance.controller";
import { EngagementController } from "./engagement.controller";
import { EngagementExtrasController } from "./engagement-extras.controller";
import { DocumentsController } from "./documents.controller";
import { KpisController } from "./kpis.controller";
import { FeedbackController } from "./feedback.controller";
import { CalibrationController } from "./calibration.controller";
import { SuccessionController } from "./succession.controller";
import { PerformanceGoalsService } from "./performance-goals.service";
import { PerformanceReviewsService } from "./performance-reviews.service";
import { ReviewCyclesService } from "./review-cycles.service";
import { OneOnOneMeetingsService } from "./one-on-one-meetings.service";
import { PerformancePipsService } from "./performance-pips.service";
import { EngagementService } from "./engagement.service";
import { EngagementMoodPollsService } from "./engagement-mood-polls.service";
import { EngagementBadgesService } from "./engagement-badges.service";
import { EngagementCommunitiesCampaignsService } from "./engagement-communities-campaigns.service";
import { DocumentsService } from "./documents.service";
import { ComplianceService } from "./compliance.service";
import { RichDocumentsService } from "./rich-documents.service";
import { LettersService } from "./letters.service";
import { KpisService } from "./kpis.service";
import { FeedbackService } from "./feedback.service";
import { CalibrationService } from "./calibration.service";
import { SuccessionService } from "./succession.service";

@Module({
  imports: [AutomationModule, HrAutomationsModule, NotificationsModule],
  controllers: [
    PerformanceController,
    EngagementController,
    EngagementExtrasController,
    DocumentsController,
    KpisController,
    FeedbackController,
    CalibrationController,
    SuccessionController,
  ],
  providers: [
    PerformanceGoalsService,
    PerformanceReviewsService,
    ReviewCyclesService,
    OneOnOneMeetingsService,
    PerformancePipsService,
    EngagementService,
    EngagementMoodPollsService,
    EngagementBadgesService,
    EngagementCommunitiesCampaignsService,
    DocumentsService,
    ComplianceService,
    RichDocumentsService,
    LettersService,
    KpisService,
    FeedbackService,
    CalibrationService,
    SuccessionService,
  ],
  exports: [DocumentsService],
})
export class HrPerformanceModule {}
