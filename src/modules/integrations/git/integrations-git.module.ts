import { Module } from "@nestjs/common";
import { ProjectsModule } from "../../build/core/projects.module";
import { IntegrationsGitController } from "./integrations-git.controller";
import { IntegrationsGitService } from "./integrations-git.service";

@Module({
  imports: [ProjectsModule],
  controllers: [IntegrationsGitController],
  providers: [IntegrationsGitService],
})
export class IntegrationsGitModule {}
