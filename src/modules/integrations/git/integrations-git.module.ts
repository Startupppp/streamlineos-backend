import { Module } from "@nestjs/common";
import { ProjectsModule } from "../../build/core/projects.module";
import { IntegrationsGitController } from "./integrations-git.controller";
import { IntegrationsGitService } from "./integrations-git.service";
import { GitConnectionsController } from "./git-connections.controller";
import { GitConnectionsService } from "./git-connections.service";

@Module({
  imports: [ProjectsModule],
  controllers: [IntegrationsGitController, GitConnectionsController],
  providers: [IntegrationsGitService, GitConnectionsService],
  exports: [GitConnectionsService],
})
export class IntegrationsGitModule {}
