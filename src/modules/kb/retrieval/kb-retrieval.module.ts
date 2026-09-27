import { Module } from "@nestjs/common";
import { AiModule } from "../../ai/core/ai.module";
import { AiJobsModule } from "../../ai/jobs/ai-jobs.module";
import { KbCoreModule } from "../core/kb-core.module";
import { KbLinkedDocumentsModule } from "../linked-documents/kb-linked-documents.module";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { KbIndexingService } from "./kb-indexing.service";
import { KbIngestionCheckpointService } from "./kb-ingestion-checkpoint.service";
import { KbAttachmentIndexingService } from "./kb-attachment-indexing.service";
import { KbArticleReindexService } from "./kb-article-reindex.service";
import { KbIngestionConsumer } from "./kb-ingestion-consumer";
import { KbIngestionDeleteConsumer } from "./kb-ingestion-delete-consumer";
import { KbIngestionLeaseService } from "./kb-ingestion-lease.service";
import { KbStuckSourceReaperService } from "./kb-stuck-source-reaper.service";
import {
  KbContentAdapterRegistry,
  KbPageAdapter,
  KbArticleAdapter,
  KbSourceAdapter,
  KbAttachmentAdapter,
} from "./kb-content-adapter";
import { KbPageBackfillService } from "./kb-page-backfill.service";
import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchService } from "./kb-search.service";
import { KbSearchRetrievalService } from "./kb-search-retrieval.service";
import { KbPageSearchQueryService } from "./kb-page-search-query.service";
import { KbRetrievalService } from "./kb-retrieval.service";
import { KbAskService } from "./kb-ask.service";
import { KbAskCitationService } from "./kb-ask-citations.service";
import { KbCitationVisibilityService } from "./kb-citation-visibility.service";
import { KbChatHistoryService } from "./kb-chat-history.service";
import { KbResearchBriefService } from "./kb-research-brief.service";
import { KbResearchBriefHandler } from "./kb-research-brief.handler";
import { KbSearchController } from "./kb-search.controller";
import { KbAskController } from "./kb-ask.controller";
import { KbConversationsController } from "./kb-conversations.controller";
import { KbResearchBriefController } from "./kb-research-brief.controller";
import { KbPageIndexingController } from "./kb-page-indexing.controller";

@Module({
  imports: [AiModule, AiJobsModule, KbCoreModule, KbLinkedDocumentsModule, OutboxModule],
  controllers: [
    KbSearchController,
    KbAskController,
    KbConversationsController,
    KbResearchBriefController,
    KbPageIndexingController,
  ],
  providers: [
    KbIndexingService,
    KbIngestionCheckpointService,
    KbAttachmentIndexingService,
    KbArticleReindexService,
    KbContentAdapterRegistry,
    KbPageAdapter,
    KbArticleAdapter,
    KbSourceAdapter,
    KbAttachmentAdapter,
    KbIngestionLeaseService,
    KbStuckSourceReaperService,
    KbIngestionConsumer,
    KbIngestionDeleteConsumer,
    KbPageBackfillService,
    KbCandidateService,
    KbSearchService,
    KbSearchRetrievalService,
    KbPageSearchQueryService,
    KbRetrievalService,
    KbAskService,
    KbAskCitationService,
    KbCitationVisibilityService,
    KbChatHistoryService,
    KbResearchBriefService,
    KbResearchBriefHandler,
  ],
  exports: [
    KbIndexingService,
    KbAttachmentIndexingService,
    KbArticleReindexService,
    KbPageBackfillService,
    KbSearchService,
    KbSearchRetrievalService,
    KbRetrievalService,
    KbAskService,
    KbAskCitationService,
    KbStuckSourceReaperService,
    KbResearchBriefService,
  ],
})
export class KbRetrievalModule {}
