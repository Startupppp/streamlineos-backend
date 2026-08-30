import { Module } from "@nestjs/common";
import { GoalsController } from "./goals.controller";
import { GoalsService } from "./goals.service";
import { GoalKeyResultsService } from "./goal-key-results.service";
import { GoalLinksService } from "./goal-links.service";

@Module({
  controllers: [GoalsController],
  providers: [GoalsService, GoalKeyResultsService, GoalLinksService],
})
export class GoalsModule {}
