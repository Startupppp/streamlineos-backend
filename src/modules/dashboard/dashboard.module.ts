import { Module } from "@nestjs/common";
import { DashboardController } from "./dashboard.controller";
import { DashboardStatsService } from "./dashboard-stats.service";
import { DashboardAvailabilityService } from "./dashboard-availability.service";
import { DashboardBirthdaysService } from "./dashboard-birthdays.service";
import { DashboardPersonalService } from "./dashboard-personal.service";
import { DashboardLeaveService } from "./dashboard-leave.service";
import { DashboardAnnouncementsService } from "./dashboard-announcements.service";
import { DashboardCrmService } from "./dashboard-crm.service";
import { DashboardProjectService } from "./dashboard-project.service";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [NotificationsModule],
  controllers: [DashboardController],
  providers: [
    DashboardStatsService,
    DashboardAvailabilityService,
    DashboardBirthdaysService,
    DashboardPersonalService,
    DashboardLeaveService,
    DashboardAnnouncementsService,
    DashboardCrmService,
    DashboardProjectService,
  ],
})
export class DashboardModule {}
