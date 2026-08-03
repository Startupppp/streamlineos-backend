import { Module } from "@nestjs/common";
import { CommentDraftsController } from "./comment-drafts.controller";
import { CommentDraftsService } from "./comment-drafts.service";

@Module({
  controllers: [CommentDraftsController],
  providers: [CommentDraftsService],
})
export class BuildCommentDraftsModule {}
