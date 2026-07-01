import { Module } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { PerformanceController } from "./performance.controller";
import { EngagementController } from "./engagement.controller";
import { DocumentsController } from "./documents.controller";
import { KpisController } from "./kpis.controller";
import { FeedbackController } from "./feedback.controller";
import { SignaturesController } from "./signatures.controller";
import { CoursesController } from "./courses.controller";
import { TrainingController } from "./training.controller";
import { CareerController } from "./career.controller";
import { PerformanceGoalsService } from "./performance-goals.service";
import { PerformanceReviewsService } from "./performance-reviews.service";
import { EngagementService } from "./engagement.service";
import { DocumentsService } from "./documents.service";
import { ComplianceService } from "./compliance.service";
import { RichDocumentsService } from "./rich-documents.service";
import { KpisService } from "./kpis.service";
import { FeedbackService } from "./feedback.service";
import { SignaturesService } from "./signatures.service";
import { CoursesService } from "./courses.service";
import { TrainingService } from "./training.service";
import { CareerService } from "./career.service";

@Module({
  imports: [AutomationModule],
  controllers: [
    PerformanceController,
    EngagementController,
    DocumentsController,
    KpisController,
    FeedbackController,
    SignaturesController,
    CoursesController,
    TrainingController,
    CareerController,
  ],
  providers: [
    PerformanceGoalsService,
    PerformanceReviewsService,
    EngagementService,
    DocumentsService,
    ComplianceService,
    RichDocumentsService,
    KpisService,
    FeedbackService,
    SignaturesService,
    CoursesService,
    TrainingService,
    CareerService,
  ],
})
export class HrPerformanceModule {}
