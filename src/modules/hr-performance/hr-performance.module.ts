import { Module } from "@nestjs/common";
import { PerformanceController } from "./performance.controller";
import { EngagementController } from "./engagement.controller";
import { DocumentsController } from "./documents.controller";
import { PerformanceGoalsService } from "./performance-goals.service";
import { PerformanceReviewsService } from "./performance-reviews.service";
import { EngagementService } from "./engagement.service";
import { DocumentsService } from "./documents.service";
import { ComplianceService } from "./compliance.service";
import { RichDocumentsService } from "./rich-documents.service";

@Module({
  controllers: [PerformanceController, EngagementController, DocumentsController],
  providers: [
    PerformanceGoalsService,
    PerformanceReviewsService,
    EngagementService,
    DocumentsService,
    ComplianceService,
    RichDocumentsService,
  ],
})
export class HrPerformanceModule {}
