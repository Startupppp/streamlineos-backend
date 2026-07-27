import { Module } from "@nestjs/common";
import { AgentTokensController } from "./agent-tokens.controller";
import { AgentController } from "./agent.controller";
import { AgentTokensService } from "./agent-tokens.service";
import { AgentAccessService } from "./agent-access.service";
import { AgentTokenGuard } from "./agent-token.guard";
import { ProjectsModule } from "../build/projects.module";

@Module({
  imports: [ProjectsModule],
  controllers: [AgentTokensController, AgentController],
  providers: [AgentTokensService, AgentAccessService, AgentTokenGuard],
})
export class AgentAccessModule {}
