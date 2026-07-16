import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { AiModule } from "../ai/ai.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { KbCreditsService } from "./kb-credits.service";
import { KbAccessService } from "./kb-access.service";
import { KbEventsService } from "./kb-events.service";
import { KbSpacesService } from "./kb-spaces.service";
import { KbCategoriesService } from "./kb-categories.service";
import { KbArticlesService } from "./kb-articles.service";
import { KbSearchService } from "./kb-search.service";
import { KbAskService } from "./kb-ask.service";
import { KbChatHistoryService } from "./kb-chat-history.service";
import { KbAnalyticsService } from "./kb-analytics.service";
import { KbMembersService } from "./kb-members.service";
import { KbAuthoringService } from "./kb-authoring.service";
import { KbIndexingService } from "./kb-indexing.service";
import { KbFromTicketService } from "./kb-from-ticket.service";
import { KbTagsService } from "./kb-tags.service";
import { KbTranslationsService } from "./kb-translations.service";
import { KbCommentsService } from "./kb-comments.service";
import { KbPagesService } from "./kb-pages.service";
import { KbPageTreeService } from "./kb-page-tree.service";
import { KbPageCommentsService } from "./kb-page-comments.service";
import { KbPageTemplatesService } from "./kb-page-templates.service";
import { KbSpacesController } from "./kb-spaces.controller";
import { KbCategoriesController } from "./kb-categories.controller";
import { KbArticlesController } from "./kb-articles.controller";
import { KbSearchController } from "./kb-search.controller";
import { KbAskController } from "./kb-ask.controller";
import { KbAnalyticsController } from "./kb-analytics.controller";
import { KbMembersController } from "./kb-members.controller";
import { KbAuthoringController } from "./kb-authoring.controller";
import { KbFromTicketController } from "./kb-from-ticket.controller";
import { KbTagsController } from "./kb-tags.controller";
import { KbTranslationsController } from "./kb-translations.controller";
import { KbCommentsController } from "./kb-comments.controller";
import { KbVerificationController } from "./kb-verification.controller";
import { KbVerificationService } from "./kb-verification.service";
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
import { KbSettingsController } from "./kb-settings.controller";
import { KbSettingsService } from "./kb-settings.service";

@Module({
  imports: [BillingModule, AiModule, NotificationsModule],
  controllers: [
    KbSpacesController,
    KbCategoriesController,
    KbArticlesController,
    KbSearchController,
    KbAskController,
    KbAnalyticsController,
    KbMembersController,
    KbAuthoringController,
    KbFromTicketController,
    KbTagsController,
    KbTranslationsController,
    KbCommentsController,
    KbVerificationController,
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
    KbSettingsController,
  ],
  providers: [
    KbCreditsService,
    KbAccessService,
    KbEventsService,
    KbSpacesService,
    KbCategoriesService,
    KbArticlesService,
    KbSearchService,
    KbAskService,
    KbChatHistoryService,
    KbAnalyticsService,
    KbMembersService,
    KbAuthoringService,
    KbIndexingService,
    KbFromTicketService,
    KbTagsService,
    KbTranslationsService,
    KbCommentsService,
    KbVerificationService,
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
    KbSettingsService,
  ],
  exports: [KbCreditsService, KbAccessService, KbEventsService, KbAskService, KbIndexingService, KbPageTreeService, KbSettingsService],
})
export class KbModule {}
