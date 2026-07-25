import { Module } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { HrAutomationsModule } from "../hr-automations/hr-automations.module";
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
import { EngagementService } from "./engagement.service";
import { EngagementExtrasService } from "./engagement-extras.service";
import { DocumentsService } from "./documents.service";
import { ComplianceService } from "./compliance.service";
import { RichDocumentsService } from "./rich-documents.service";
import { LettersService } from "./letters.service";
import { KpisService } from "./kpis.service";
import { FeedbackService } from "./feedback.service";
import { CalibrationService } from "./calibration.service";
import { SuccessionService } from "./succession.service";

@Module({
  imports: [AutomationModule, HrAutomationsModule],
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
    EngagementService,
    EngagementExtrasService,
    DocumentsService,
    ComplianceService,
    RichDocumentsService,
    LettersService,
    KpisService,
    FeedbackService,
    CalibrationService,
    SuccessionService,
  ],
})
export class HrPerformanceModule {}
