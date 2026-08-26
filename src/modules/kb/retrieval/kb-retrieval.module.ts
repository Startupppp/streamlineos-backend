import { Module } from "@nestjs/common";
import { AiModule } from "../../ai/core/ai.module";
import { AiJobsModule } from "../../ai/jobs/ai-jobs.module";
import { KbCoreModule } from "../core/kb-core.module";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { KbIndexingService } from "./kb-indexing.service";
import { KbIngestionConsumer } from "./kb-ingestion-consumer";
import { KbPageBackfillService } from "./kb-page-backfill.service";
import { KbSearchService } from "./kb-search.service";
import { KbAskService } from "./kb-ask.service";
import { KbChatHistoryService } from "./kb-chat-history.service";
import { KbResearchBriefService } from "./kb-research-brief.service";
import { KbResearchBriefHandler } from "./kb-research-brief.handler";
import { KbSearchController } from "./kb-search.controller";
import { KbAskController } from "./kb-ask.controller";
import { KbResearchBriefController } from "./kb-research-brief.controller";
import { KbPageIndexingController } from "./kb-page-indexing.controller";

@Module({
  imports: [AiModule, AiJobsModule, KbCoreModule, OutboxModule],
  controllers: [KbSearchController, KbAskController, KbResearchBriefController, KbPageIndexingController],
  providers: [
    KbIndexingService,
    KbIngestionConsumer,
    KbPageBackfillService,
    KbSearchService,
    KbAskService,
    KbChatHistoryService,
    KbResearchBriefService,
    KbResearchBriefHandler,
  ],
  exports: [KbIndexingService, KbPageBackfillService, KbSearchService, KbAskService],
})
export class KbRetrievalModule {}
