import { Module } from "@nestjs/common";
import { TasksController } from "./tasks.controller";
import { TasksService } from "./tasks.service";
import { TaskNotificationsService } from "./task-notifications.service";

@Module({
  controllers: [TasksController],
  providers: [TasksService, TaskNotificationsService],
  exports: [TasksService],
})
export class TasksModule {}
