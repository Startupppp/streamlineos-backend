import { Module } from "@nestjs/common";
import { IntegrationsGitController } from "./integrations-git.controller";
import { IntegrationsGitService } from "./integrations-git.service";

@Module({
  controllers: [IntegrationsGitController],
  providers: [IntegrationsGitService],
})
export class IntegrationsGitModule {}
