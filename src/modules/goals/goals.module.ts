import { Module } from "@nestjs/common";
import { GoalsController } from "./goals.controller";
import { GoalsService } from "./goals.service";
import { GoalLinksService } from "./goal-links.service";
import { GoalKeyResultsService } from "./goal-key-results.service";

@Module({
  controllers: [GoalsController],
  providers: [GoalsService, GoalLinksService, GoalKeyResultsService],
})
export class GoalsModule {}
