import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { KbCreditsService } from "./kb-credits.service";
import { KbAccessService } from "./kb-access.service";
import { KbEventsService } from "./kb-events.service";
import { KbSpacesService } from "./kb-spaces.service";
import { KbCategoriesService } from "./kb-categories.service";
import { KbArticlesService } from "./kb-articles.service";
import { KbSearchService } from "./kb-search.service";
import { KbAskService } from "./kb-ask.service";
import { KbSpacesController } from "./kb-spaces.controller";
import { KbCategoriesController } from "./kb-categories.controller";
import { KbArticlesController } from "./kb-articles.controller";
import { KbSearchController } from "./kb-search.controller";
import { KbAskController } from "./kb-ask.controller";

@Module({
  imports: [AiModule],
  controllers: [
    KbSpacesController,
    KbCategoriesController,
    KbArticlesController,
    KbSearchController,
    KbAskController,
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
  ],
  exports: [KbCreditsService, KbAccessService, KbEventsService],
})
export class KbModule {}
