import { Module } from "@nestjs/common";
import { KbArticleMigrationService } from "./kb-article-migration.service";
import { KbArticleMigrationController } from "./kb-article-migration.controller";

@Module({
  controllers: [KbArticleMigrationController],
  providers: [KbArticleMigrationService],
})
export class KbMigrationModule {}
