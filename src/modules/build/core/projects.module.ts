import { Module } from "@nestjs/common";
import { BillingModule } from "../../billing/core/billing.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { UsersModule } from "../../users/users.module";
import { ProjectsController } from "./projects.controller";
import { ProjectsTicketsController } from "./projects-tickets.controller";
import { ProjectsTicketCommentsController } from "./projects-ticket-comments.controller";
import { ProjectsTicketChecklistsController } from "./projects-ticket-checklists.controller";
import { ProjectsTicketAssociationsController } from "./projects-ticket-associations.controller";
import { ProjectsReportsController } from "./projects-reports.controller";
import { ProjectsBudgetController } from "./projects-budget.controller";
import { ProjectsTemplatesController } from "./projects-templates.controller";
import { ProjectsRoadmapController } from "./projects-roadmap.controller";
import { ProjectsCustomFieldsController } from "./projects-custom-fields.controller";
import { ProjectsReleasesController } from "./projects-releases.controller";
import { ProjectsWebhooksController } from "./projects-webhooks.controller";
import { ProjectsAutomationsController } from "./projects-automations.controller";
import { ProjectsWorkspaceMembersController } from "./projects-workspace-members.controller";
import { ProjectsWorkspaceMembersService } from "./projects-workspace-members.service";
import { ProjectsCustomersController } from "./projects-customers.controller";
import { ProjectsCustomersService } from "./projects-customers.service";
import { ProjectsService } from "./projects.service";
import { ProjectsQueryService } from "./projects-query.service";
import { ProjectsWriteService } from "./projects-write.service";
import { ProjectsProvisionService } from "./projects-provision.service";
import { ProjectsEmailService } from "./projects-email.service";
import { ProjectsMembersService } from "./projects-members.service";
import { BuildNotificationVisibility } from "./build-notification-visibility";
import { ProjectsTicketsService } from "./projects-tickets.service";
import { ProjectsTicketsCreateService } from "./projects-tickets-create.service";
import { ProjectsTicketsUpdateService } from "./projects-tickets-update.service";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";
import { ProjectsWorkQueryService } from "./projects-work-query.service";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
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
import { ProjectsCustomStatesService } from "./projects-custom-states.service";
import { ProjectsLabelsService } from "./projects-labels.service";
import { ProjectsTicketChecklistsService } from "./projects-ticket-checklists.service";
import { ProjectsTicketLinksService } from "./projects-ticket-links.service";
import { ProjectsTicketRelationsService } from "./projects-ticket-relations.service";
import { BuildAutomationRunnerService } from "./build-automation-runner.service";

@Module({
  imports: [BillingModule, NotificationsModule, UsersModule],
  controllers: [
    ProjectsRoadmapController,
    ProjectsTemplatesController,
    ProjectsReportsController,
    ProjectsBudgetController,
    ProjectsTicketsController,
    ProjectsTicketCommentsController,
    ProjectsTicketChecklistsController,
    ProjectsTicketAssociationsController,
    ProjectsCustomFieldsController,
    ProjectsReleasesController,
    ProjectsWebhooksController,
    ProjectsAutomationsController,
    ProjectsWorkspaceMembersController,
    ProjectsCustomersController,
    ProjectsController,
  ],
  providers: [
    BuildNotificationVisibility,
    ProjectsService,
    ProjectsQueryService,
    ProjectsWriteService,
    ProjectsProvisionService,
    ProjectsEmailService,
    ProjectsMembersService,
    ProjectsTicketsService,
    ProjectsTicketsCreateService,
    ProjectsTicketsUpdateService,
    ProjectsTicketsQueryService,
    ProjectsWorkQueryService,
    ProjectsTicketsReadService,
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
    ProjectsCustomersService,
    ProjectsWorkspaceMembersService,
    ProjectsCustomStatesService,
    ProjectsLabelsService,
    ProjectsTicketChecklistsService,
    ProjectsTicketLinksService,
    ProjectsTicketRelationsService,
    BuildAutomationRunnerService,
  ],
  exports: [
    ProjectsTicketsService,
    ProjectsWebhooksDispatchService,
    ProjectsService,
    ProjectsWorkQueryService,
    ProjectsTicketSubresourcesService,
  ],
})
export class ProjectsModule {}
