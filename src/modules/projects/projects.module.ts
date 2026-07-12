import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { ProjectsController } from "./projects.controller";
import { ProjectsTicketsController } from "./projects-tickets.controller";
import { ProjectsReportsController } from "./projects-reports.controller";
import { ProjectsBudgetController } from "./projects-budget.controller";
import { ProjectsTemplatesController } from "./projects-templates.controller";
import { ProjectsRoadmapController } from "./projects-roadmap.controller";
import { ProjectsCustomFieldsController } from "./projects-custom-fields.controller";
import { ProjectsReleasesController } from "./projects-releases.controller";
import { ProjectsWebhooksController } from "./projects-webhooks.controller";
import { ProjectsAutomationsController } from "./projects-automations.controller";
import { ProjectsService } from "./projects.service";
import { ProjectsProvisionService } from "./projects-provision.service";
import { ProjectsEmailService } from "./projects-email.service";
import { ProjectsMembersService } from "./projects-members.service";
import { ProjectsTicketsService } from "./projects-tickets.service";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";
import { ProjectsWorkQueryService } from "./projects-work-query.service";
import { ProjectsTicketsTransferService } from "./projects-tickets-transfer.service";
import { ProjectsTicketSubresourcesService } from "./projects-ticket-subresources.service";
import { ProjectsTicketCommentsService } from "./projects-ticket-comments.service";
import { ProjectsActivityService } from "./projects-activity.service";
import { ProjectsAnalyticsService } from "./projects-analytics.service";
import { ProjectsReportsService } from "./projects-reports.service";
import { ProjectsBudgetService } from "./projects-budget.service";
import { ProjectsTemplatesService } from "./projects-templates.service";
import { ProjectsRoadmapService } from "./projects-roadmap.service";
import { ProjectsCustomFieldsService } from "./projects-custom-fields.service";
import { ProjectsReleasesService } from "./projects-releases.service";
import { ProjectsWebhooksService } from "./projects-webhooks.service";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import { ProjectsAutomationsService } from "./projects-automations.service";

@Module({
  imports: [NotificationsModule],
  controllers: [
    ProjectsRoadmapController,
    ProjectsTemplatesController,
    ProjectsReportsController,
    ProjectsBudgetController,
    ProjectsTicketsController,
    ProjectsCustomFieldsController,
    ProjectsReleasesController,
    ProjectsWebhooksController,
    ProjectsAutomationsController,
    ProjectsController,
  ],
  providers: [
    ProjectsService,
    ProjectsProvisionService,
    ProjectsEmailService,
    ProjectsMembersService,
    ProjectsTicketsService,
    ProjectsTicketsQueryService,
    ProjectsWorkQueryService,
    ProjectsTicketsTransferService,
    ProjectsTicketSubresourcesService,
    ProjectsTicketCommentsService,
    ProjectsActivityService,
    ProjectsAnalyticsService,
    ProjectsReportsService,
    ProjectsBudgetService,
    ProjectsTemplatesService,
    ProjectsRoadmapService,
    ProjectsCustomFieldsService,
    ProjectsReleasesService,
    ProjectsWebhooksService,
    ProjectsWebhooksDispatchService,
    ProjectsAutomationsService,
  ],
  exports: [ProjectsTicketsService, ProjectsWebhooksDispatchService],
})
export class ProjectsModule {}
