import { Module } from "@nestjs/common";
import { AiGatewayModule } from "../../ai/core/gateway/ai-gateway.module";
import { CommentDraftsController } from "./comment-drafts.controller";
import { CommentDraftsService } from "./comment-drafts.service";
import { CommentDraftGeneratorService } from "./comment-draft-generator.service";

@Module({
  imports: [AiGatewayModule],
  controllers: [CommentDraftsController],
  providers: [CommentDraftsService, CommentDraftGeneratorService],
})
export class BuildCommentDraftsModule {}
