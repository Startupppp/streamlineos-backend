import { Module } from "@nestjs/common";
import { NotificationsModule } from "../../notifications/notifications.module";
import { KbNotificationVisibility } from "./kb-notification-visibility";
import { KbCreditsService } from "./kb-credits.service";
import { KbAccessService } from "./kb-access.service";
import { KbEventsService } from "./kb-events.service";
import { KbSettingsController } from "./kb-settings.controller";
import { KbSettingsService } from "./kb-settings.service";
import { KbTagsController } from "./kb-tags.controller";
import { KbTagsService } from "./kb-tags.service";
import { KbTranslationsController } from "./kb-translations.controller";
import { KbTranslationsService } from "./kb-translations.service";

@Module({
  imports: [NotificationsModule],
  controllers: [KbSettingsController, KbTagsController, KbTranslationsController],
  providers: [
    KbNotificationVisibility,
    KbCreditsService,
    KbAccessService,
    KbEventsService,
    KbSettingsService,
    KbTagsService,
    KbTranslationsService,
  ],
  exports: [KbCreditsService, KbAccessService, KbEventsService, KbSettingsService, KbTagsService, KbTranslationsService],
})
export class KbCoreModule {}
