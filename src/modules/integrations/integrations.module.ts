import { Module } from "@nestjs/common";
import { IntegrationsModule } from "./core/integrations.module";
import { IntegrationsGitModule } from "./git/integrations-git.module";

const INTEGRATIONS_MODULES = [IntegrationsModule, IntegrationsGitModule];

@Module({
  imports: INTEGRATIONS_MODULES,
  exports: INTEGRATIONS_MODULES,
})
export class IntegrationsRootModule {}
