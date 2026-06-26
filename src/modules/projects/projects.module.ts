import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { ProjectsController } from "./projects.controller";
import { ProjectsTicketsController } from "./projects-tickets.controller";
import { ProjectsReportsController } from "./projects-reports.controller";
import { ProjectsBudgetController } from "./projects-budget.controller";
import { ProjectsTemplatesController } from "./projects-templates.controller";
import { ProjectsRoadmapController } from "./projects-roadmap.controller";
import { ProjectsService } from "./projects.service";
import { ProjectsMembersService } from "./projects-members.service";
import { ProjectsTicketsService } from "./projects-tickets.service";
import { ProjectsTicketSubresourcesService } from "./projects-ticket-subresources.service";
import { ProjectsActivityService } from "./projects-activity.service";
import { ProjectsAnalyticsService } from "./projects-analytics.service";
import { ProjectsReportsService } from "./projects-reports.service";
import { ProjectsBudgetService } from "./projects-budget.service";
import { ProjectsTemplatesService } from "./projects-templates.service";
import { ProjectsRoadmapService } from "./projects-roadmap.service";

@Module({
  imports: [NotificationsModule],
  controllers: [
    ProjectsRoadmapController,
    ProjectsTemplatesController,
    ProjectsReportsController,
    ProjectsBudgetController,
    ProjectsTicketsController,
    ProjectsController,
  ],
  providers: [
    ProjectsService,
    ProjectsMembersService,
    ProjectsTicketsService,
    ProjectsTicketSubresourcesService,
    ProjectsActivityService,
    ProjectsAnalyticsService,
    ProjectsReportsService,
    ProjectsBudgetService,
    ProjectsTemplatesService,
    ProjectsRoadmapService,
  ],
})
export class ProjectsModule {}
