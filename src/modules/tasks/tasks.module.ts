import { Module } from "@nestjs/common";
import { TasksController } from "./tasks.controller";
import { TasksService } from "./tasks.service";
import { TaskNotificationsService } from "./task-notifications.service";
import { TaskSequencesService } from "./task-sequences.service";
import { TaskAnalyticsService } from "./task-analytics.service";
import { AccessModule } from "../access/access.module";
import { CalendarModule } from "../calendar/calendar.module";
import { TasksCalendarSource } from "./tasks-calendar-source";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [
    CalendarModule,
    AccessModule,
    NotificationsModule,
  ],
  controllers: [TasksController],
  providers: [TasksService, TaskNotificationsService, TasksCalendarSource, TaskSequencesService, TaskAnalyticsService],
  exports: [TasksService, TaskSequencesService, TaskAnalyticsService],
})
export class TasksModule {}
