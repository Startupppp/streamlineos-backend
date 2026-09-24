import { Module } from "@nestjs/common";
import { NotificationsModule } from "../../notifications/notifications.module";
import { KbNotificationVisibility } from "./kb-notification-visibility";
import { KbCreditsService } from "./kb-credits.service";
import { KbAccessService } from "./kb-access.service";
import { KnowledgeAuthorizationService } from "./authorization/knowledge-authorization.service";
import { KnowledgeCollectionService } from "./collection/knowledge-collection.service";
import { KbPageCollectionController } from "./kb-page-collection.controller";
import { KbEventsService } from "./kb-events.service";
import { KbSettingsController } from "./kb-settings.controller";
import { KbHrLinkFlagsController } from "./kb-hr-link-flags.controller";
import { KbHrLinkFlagsService } from "./kb-hr-link-flags.service";
import { KbSettingsService } from "./kb-settings.service";
import { KbTagsController } from "./kb-tags.controller";
import { KbTagsService } from "./kb-tags.service";
import { KbTranslationsController } from "./kb-translations.controller";
import { KbTranslationsService } from "./kb-translations.service";

@Module({
  imports: [NotificationsModule],
  controllers: [
    KbPageCollectionController,
    KbSettingsController,
    KbHrLinkFlagsController,
    KbTagsController,
    KbTranslationsController,
  ],
  providers: [
    KbNotificationVisibility,
    KbCreditsService,
    KbAccessService,
    KnowledgeAuthorizationService,
    KnowledgeCollectionService,
    KbEventsService,
    KbSettingsService,
    KbHrLinkFlagsService,
    KbTagsService,
    KbTranslationsService,
  ],
  exports: [KbCreditsService, KbAccessService, KnowledgeAuthorizationService, KnowledgeCollectionService, KbEventsService, KbSettingsService, KbHrLinkFlagsService, KbTagsService, KbTranslationsService],
})
export class KbCoreModule {}
