import { Module } from "@nestjs/common";
import { RelationshipsModule } from "../relationships/relationships.module";
import { ActivitiesController } from "./activities.controller";
import { ActivitiesService } from "./activities.service";
import { MyTasksService } from "./my-tasks.service";

@Module({
  // The relationship state is a materialisation of what this module writes, so
  // an activity created here has to move it — a sweep is a repair, never the
  // only path.
  imports: [RelationshipsModule],
  controllers: [ActivitiesController],
  providers: [ActivitiesService, MyTasksService],
  // Ticket 10's ingress and ticket 12's extraction both write activities.
  exports: [ActivitiesService],
})
export class ActivitiesModule {}
