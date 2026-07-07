import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { KbCreditsService } from "./kb-credits.service";
import { KbAccessService } from "./kb-access.service";
import { KbEventsService } from "./kb-events.service";
import { KbSpacesService } from "./kb-spaces.service";
import { KbArticlesService } from "./kb-articles.service";
import { KbSearchService } from "./kb-search.service";
import { KbAskService } from "./kb-ask.service";
import { KbAnalyticsService } from "./kb-analytics.service";
import { KbIndexingService } from "./kb-indexing.service";
import { KbFromTicketService } from "./kb-from-ticket.service";
import { KbPagesService } from "./kb-pages.service";
import { KbPageTreeService } from "./kb-page-tree.service";
import { KbPageCommentsService } from "./kb-page-comments.service";
import { KbPageTemplatesService } from "./kb-page-templates.service";
import { KbSpacesController } from "./kb-spaces.controller";
import { KbSearchController } from "./kb-search.controller";
import { KbAskController } from "./kb-ask.controller";
import { KbAnalyticsController } from "./kb-analytics.controller";
import { KbFromTicketController } from "./kb-from-ticket.controller";
import { KbWidgetController } from "./kb-widget.controller";
import { KbPagesController } from "./kb-pages.controller";
import { KbPageCommentsController } from "./kb-page-comments.controller";
import { KbPageTemplatesController } from "./kb-page-templates.controller";
import { KbPublicPagesController } from "./kb-public-pages.controller";
import { KbPageReviewsController } from "./kb-page-reviews.controller";
import { KbPageReviewsService } from "./kb-page-reviews.service";
import { KbImportExportController } from "./kb-import-export.controller";
import { KbImportExportService } from "./kb-import-export.service";
import { KbPageRecordLinksController } from "./kb-page-record-links.controller";
import { KbPageRecordLinksService } from "./kb-page-record-links.service";
import { KbPageIndexingController } from "./kb-page-indexing.controller";
import { KbArticleMigrationController } from "./kb-article-migration.controller";
import { KbArticleMigrationService } from "./kb-article-migration.service";
import { KbMediaController } from "./kb-media.controller";
import { KbMediaService } from "./kb-media.service";
import { KbSourcesController } from "./kb-sources.controller";
import { KbSourcesService } from "./kb-sources.service";

@Module({
  imports: [AiModule, NotificationsModule],
  controllers: [
    KbSpacesController,
    KbSearchController,
    KbAskController,
    KbAnalyticsController,
    KbFromTicketController,
    KbWidgetController,
    KbPagesController,
    KbPageCommentsController,
    KbPageTemplatesController,
    KbPublicPagesController,
    KbPageReviewsController,
    KbImportExportController,
    KbPageRecordLinksController,
    KbPageIndexingController,
    KbArticleMigrationController,
    KbMediaController,
    KbSourcesController,
  ],
  providers: [
    KbCreditsService,
    KbAccessService,
    KbEventsService,
    KbSpacesService,
    KbArticlesService,
    KbSearchService,
    KbAskService,
    KbAnalyticsService,
    KbIndexingService,
    KbFromTicketService,
    KbPagesService,
    KbPageTreeService,
    KbPageCommentsService,
    KbPageTemplatesService,
    KbPageReviewsService,
    KbImportExportService,
    KbPageRecordLinksService,
    KbArticleMigrationService,
    KbMediaService,
    KbSourcesService,
  ],
  exports: [KbCreditsService, KbAccessService, KbEventsService, KbAskService, KbIndexingService],
})
export class KbModule {}
