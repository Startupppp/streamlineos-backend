import { Module } from "@nestjs/common";
import { AutomationModule } from "../../automation/automation.module";
import { HrAutomationsModule } from "../automations/hr-automations.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { KbCoreModule } from "../../kb/core/kb-core.module";
import { KbLinkedDocumentsModule } from "../../kb/linked-documents/kb-linked-documents.module";
import { PerformanceController } from "./performance.controller";
import { EngagementController } from "./engagement.controller";
import { EngagementExtrasController } from "./engagement-extras.controller";
import { EngagementBadgesController } from "./engagement-badges.controller";
import { DocumentsController } from "./documents.controller";
import { SelfDocumentAcknowledgementsController } from "./self-document-acknowledgements.controller";
import { DocumentClassificationController } from "./document-classification.controller";
import { DocumentKbLinkController } from "./document-kb-link.controller";
import { DocumentVersionsController } from "./document-versions.controller";
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
import { DocumentAccessService } from "./document-access.service";
import { DocumentClassificationService } from "./document-classification.service";
import { DocumentVersionsService } from "./document-versions.service";
import { ComplianceService } from "./compliance.service";
import { RichDocumentsService } from "./rich-documents.service";
import { LettersService } from "./letters.service";
import { KpisService } from "./kpis.service";
import { FeedbackService } from "./feedback.service";
import { CalibrationService } from "./calibration.service";
import { SuccessionService } from "./succession.service";

@Module({
  imports: [AutomationModule, HrAutomationsModule, NotificationsModule, KbCoreModule, KbLinkedDocumentsModule],
  controllers: [
    PerformanceController,
    EngagementController,
    EngagementExtrasController,
    EngagementBadgesController,
    DocumentsController,
    SelfDocumentAcknowledgementsController,
    DocumentClassificationController,
    DocumentKbLinkController,
    DocumentVersionsController,
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
    DocumentAccessService,
    DocumentClassificationService,
    DocumentVersionsService,
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
