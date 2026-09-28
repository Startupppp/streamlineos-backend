import { Module } from "@nestjs/common";
import { ProjectsRetentionSettingsController } from "./projects-retention-settings.controller";
import { ProjectsRetentionSettingsService } from "./projects-retention-settings.service";

@Module({
  controllers: [ProjectsRetentionSettingsController],
  providers: [ProjectsRetentionSettingsService],
})
export class ProjectsRetentionSettingsModule {}
