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

/**
 * `NotificationsModule` was imported only for `DashboardPersonalService`'s
 * unread-notification count, which was deleted as dead: the number reached no
 * client and was the most expensive query on the Home surface. Nothing under
 * `dashboard/` injects `NotificationsService` any more.
 */
@Module({
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
