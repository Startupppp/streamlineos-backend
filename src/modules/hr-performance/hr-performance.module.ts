import { Module } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { HrAutomationsModule } from "../hr-automations/hr-automations.module";
import { PerformanceController } from "./performance.controller";
import { EngagementController } from "./engagement.controller";
import { EngagementExtrasController } from "./engagement-extras.controller";
import { DocumentsController } from "./documents.controller";
import { KpisController } from "./kpis.controller";
import { FeedbackController } from "./feedback.controller";
import { CoursesController } from "./courses.controller";
import { TrainingController } from "./training.controller";
import { CareerController } from "./career.controller";
import { CalibrationController } from "./calibration.controller";
import { SuccessionController } from "./succession.controller";
import { MentorshipController } from "./mentorship.controller";
import { SkillGapController } from "./skill-gap.controller";
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
import { CoursesService } from "./courses.service";
import { TrainingService } from "./training.service";
import { CareerService } from "./career.service";
import { CalibrationService } from "./calibration.service";
import { SuccessionService } from "./succession.service";
import { MentorshipService } from "./mentorship.service";
import { SkillGapService } from "./skill-gap.service";

@Module({
  imports: [AutomationModule, HrAutomationsModule],
  controllers: [
    PerformanceController,
    EngagementController,
    EngagementExtrasController,
    DocumentsController,
    KpisController,
    FeedbackController,
    CoursesController,
    TrainingController,
    CareerController,
    CalibrationController,
    SuccessionController,
    MentorshipController,
    SkillGapController,
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
    CoursesService,
    TrainingService,
    CareerService,
    CalibrationService,
    SuccessionService,
    MentorshipService,
    SkillGapService,
  ],
  exports: [CoursesService],
})
export class HrPerformanceModule {}
