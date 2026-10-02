import { Module } from "@nestjs/common";
import { AgentPulseController } from "./agent-pulse.controller";
import { AgentPulseService } from "./agent-pulse.service";
import { ProjectsModule } from "../core/projects.module";

@Module({
  imports: [ProjectsModule],
  controllers: [AgentPulseController],
  providers: [AgentPulseService],
})
export class BuildAgentPulseModule {}
