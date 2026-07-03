import { Module } from "@nestjs/common";
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

@Module({
  imports: [AiModule, NotificationsModule],
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
  ],
  exports: [KbCreditsService, KbAccessService, KbEventsService, KbAskService, KbIndexingService],
})
export class KbModule {}
