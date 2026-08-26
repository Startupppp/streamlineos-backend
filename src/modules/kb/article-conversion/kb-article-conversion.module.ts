import { Module } from "@nestjs/common";
import { KbArticleMigrationService } from "./kb-article-migration.service";
import { KbArticleMigrationController } from "./kb-article-migration.controller";

// Permanent operator tool, not a transition: the help centre is a live product with
// full article CRUD, so this backlog never drains and this module never becomes deletable.
@Module({
  controllers: [KbArticleMigrationController],
  providers: [KbArticleMigrationService],
})
export class KbArticleConversionModule {}
