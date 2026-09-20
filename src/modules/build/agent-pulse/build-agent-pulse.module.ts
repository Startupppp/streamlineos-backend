import { Module } from "@nestjs/common";
import { AgentPulseController } from "./agent-pulse.controller";
import { AgentPulseService } from "./agent-pulse.service";

@Module({
  controllers: [AgentPulseController],
  providers: [AgentPulseService],
})
export class BuildAgentPulseModule {}
