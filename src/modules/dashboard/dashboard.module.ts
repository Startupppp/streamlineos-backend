import { Module } from "@nestjs/common";
import { DashboardController } from "./dashboard.controller";
import { DashboardHrService } from "./dashboard-hr.service";
import { DashboardLeaveService } from "./dashboard-leave.service";
import { DashboardAnnouncementsService } from "./dashboard-announcements.service";
import { DashboardCrmService } from "./dashboard-crm.service";
import { DashboardProjectService } from "./dashboard-project.service";

@Module({
  controllers: [DashboardController],
  providers: [
    DashboardHrService,
    DashboardLeaveService,
    DashboardAnnouncementsService,
    DashboardCrmService,
    DashboardProjectService,
  ],
})
export class DashboardModule {}
