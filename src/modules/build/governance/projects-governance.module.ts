import { Module } from "@nestjs/common";
import { RisksController } from "./risks.controller";
import { RisksService } from "./risks.service";
import { DecisionsController } from "./decisions.controller";
import { DecisionsService } from "./decisions.service";

@Module({
  controllers: [RisksController, DecisionsController],
  providers: [RisksService, DecisionsService],
})
export class ProjectsGovernanceModule {}
