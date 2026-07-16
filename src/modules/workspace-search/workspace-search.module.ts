import { Module } from "@nestjs/common";
import { WorkspaceSearchController } from "./workspace-search.controller";
import { WorkspaceSearchService } from "./workspace-search.service";
import { WorkspaceSearchRetrievalService } from "./workspace-search-retrieval.service";
import { WorkspaceSearchIndexingService } from "./workspace-search-indexing.service";
import { AiModule } from "../ai/ai.module";

@Module({
  imports: [AiModule],
  controllers: [WorkspaceSearchController],
  providers: [WorkspaceSearchService, WorkspaceSearchRetrievalService, WorkspaceSearchIndexingService],
  exports: [WorkspaceSearchIndexingService],
})
export class WorkspaceSearchModule {}
