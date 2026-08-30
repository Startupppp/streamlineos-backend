import { Module } from "@nestjs/common";
import { AgentTokensController } from "./agent-tokens.controller";
import { AgentController } from "./agent.controller";
import { AgentTokensService } from "./agent-tokens.service";
import { AgentAccessService } from "./agent-access.service";
import { AgentTokenGuard } from "./agent-token.guard";
import { ProjectsModule } from "../build/core/projects.module";
import { AccessModule } from "../access/access.module";

@Module({
  imports: [ProjectsModule, AccessModule],
  controllers: [AgentTokensController, AgentController],
  providers: [AgentTokensService, AgentAccessService, AgentTokenGuard],
})
export class AgentAccessModule {}
