import { Module } from "@nestjs/common";
import { ActivitiesController } from "./activities.controller";
import { ActivitiesService } from "./activities.service";

@Module({
  controllers: [ActivitiesController],
  providers: [ActivitiesService],
  // Ticket 10's ingress and ticket 12's extraction both write activities.
  exports: [ActivitiesService],
})
export class ActivitiesModule {}
