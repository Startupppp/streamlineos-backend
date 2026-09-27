import { Module } from "@nestjs/common";
import { AiModule } from "../../ai/core/ai.module";
import { AiJobsModule } from "../../ai/jobs/ai-jobs.module";
import { KbCoreModule } from "../core/kb-core.module";
import { KbRetrievalModule } from "../retrieval/kb-retrieval.module";
import { KbArticlesService } from "./kb-articles.service";
import { KbArticleQueryService } from "./kb-article-query.service";
import { KbCategoriesService } from "./kb-categories.service";
import { KbCommentsService } from "./kb-comments.service";
import { KbArticleAiService } from "./kb-article-ai.service";
import { KbAiFeedbackService } from "./kb-ai-feedback.service";
import { KbAuthoringService } from "./kb-authoring.service";
import { KbVerificationService } from "./kb-verification.service";
import { KbFromTicketService } from "./kb-from-ticket.service";
import { KbAnalyticsService } from "./kb-analytics.service";
import { KbContentGapService } from "./kb-content-gap.service";
import { KbContradictionScannerService } from "../content-health/kb-contradiction-scanner.service";
import { KbArticleAiController } from "./kb-article-ai.controller";
import { KbAiFeedbackController } from "./kb-ai-feedback.controller";
import { KbFromTicketController } from "./kb-from-ticket.controller";
import { KbAnalyticsController } from "./kb-analytics.controller";
import { KbWidgetController } from "./kb-widget.controller";

@Module({
  imports: [AiModule, AiJobsModule, KbCoreModule, KbRetrievalModule],
  controllers: [
    KbArticleAiController,
    KbAiFeedbackController,
    KbFromTicketController,
    KbAnalyticsController,
    KbWidgetController,
  ],
  providers: [
    KbArticlesService,
    KbArticleQueryService,
    KbCategoriesService,
    KbCommentsService,
    KbArticleAiService,
    KbAiFeedbackService,
    KbAuthoringService,
    KbVerificationService,
    KbFromTicketService,
    KbAnalyticsService,
    KbContentGapService,
    KbContradictionScannerService,
  ],
  exports: [KbArticlesService, KbContradictionScannerService],
})
export class KbHelpCentreModule {}
