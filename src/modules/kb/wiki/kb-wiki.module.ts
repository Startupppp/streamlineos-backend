import { Module } from "@nestjs/common";
import { AiModule } from "../../ai/core/ai.module";
import { BillingModule } from "../../billing/core/billing.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { KbCoreModule } from "../core/kb-core.module";
import { KbRetrievalModule } from "../retrieval/kb-retrieval.module";
import { KbSpacesService } from "./kb-spaces.service";
import { KbMembersService } from "./kb-members.service";
import { KbPagesService } from "./kb-pages.service";
import { KbPageVersionsService } from "./kb-page-versions.service";
import { KbPageVisitsService } from "./kb-page-visits.service";
import { KbPageTreeService } from "./kb-page-tree.service";
import { KbPageDuplicateService } from "./kb-page-duplicate.service";
import { KbPageCommentsService } from "./kb-page-comments.service";
import { KbPageTemplatesService } from "./kb-page-templates.service";
import { KbPageReviewsService } from "./kb-page-reviews.service";
import { KbPageReviewsQueryService } from "./kb-page-reviews-query.service";
import { KbPageRecordLinksService } from "./kb-page-record-links.service";
import { KbMediaService } from "./kb-media.service";
import { KbSourcesService } from "./kb-sources.service";
import { KbImportExportService } from "./kb-import-export.service";
import { KbPageAiService } from "./kb-page-ai.service";
import { KbPageStatusService } from "./kb-page-status.service";
import { KbSpacesController } from "./kb-spaces.controller";
import { KbMembersController } from "./kb-members.controller";
import { KbPagesController } from "./kb-pages.controller";
import { KbPageCommentsController } from "./kb-page-comments.controller";
import { KbPageTemplatesController } from "./kb-page-templates.controller";
import { KbPublicPagesController } from "./kb-public-pages.controller";
import { KbPageReviewsController } from "./kb-page-reviews.controller";
import { KbImportExportController } from "./kb-import-export.controller";
import { KbPageRecordLinksController } from "./kb-page-record-links.controller";
import { KbMediaController } from "./kb-media.controller";
import { KbSourcesController } from "./kb-sources.controller";
import { KbPageAiController } from "./kb-page-ai.controller";
import { KbPageGrantsController } from "./kb-page-grants.controller";
import { KbPageGrantsService } from "./kb-page-grants.service";

@Module({
  imports: [
    AiModule,
    BillingModule,
    NotificationsModule,
    KbCoreModule,
    KbRetrievalModule,
  ],
  controllers: [
    KbSpacesController,
    KbMembersController,
    KbPagesController,
    KbPageCommentsController,
    KbPageTemplatesController,
    KbPublicPagesController,
    KbPageReviewsController,
    KbImportExportController,
    KbPageRecordLinksController,
    KbMediaController,
    KbSourcesController,
    KbPageAiController,
    KbPageGrantsController,
  ],
  providers: [
    KbSpacesService,
    KbMembersService,
    KbPagesService,
    KbPageStatusService,
    KbPageVersionsService,
    KbPageVisitsService,
    KbPageTreeService,
    KbPageDuplicateService,
    KbPageCommentsService,
    KbPageTemplatesService,
    KbPageReviewsService,
    KbPageReviewsQueryService,
    KbPageRecordLinksService,
    KbMediaService,
    KbSourcesService,
    KbImportExportService,
    KbPageAiService,
    KbPageGrantsService,
  ],
  exports: [KbPageTreeService],
})
export class KbWikiModule {}
