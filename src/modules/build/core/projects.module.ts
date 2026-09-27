import { Module } from "@nestjs/common";
import { BillingModule } from "../../billing/core/billing.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { UsersModule } from "../../users/users.module";
import { ProjectsController } from "./projects.controller";
import { ProjectResourcesController } from "./project-resources.controller";
import {
  ProjectsTicketsController,
  ProjectsTicketCommentsController,
  ProjectsTicketChecklistsController,
  ProjectsTicketAssociationsController,
  ProjectsTicketsService,
  ProjectsTicketsDeleteService,
  ProjectsTicketsCreateService,
  ProjectsTicketsUpdateService,
  ProjectsTicketsQueryService,
  ProjectsTicketsReadService,
  ProjectsTicketsDetailService,
  ProjectsTicketsTransferService,
  ProjectsTicketSubresourcesService,
  ProjectsTicketCommentsService,
  ProjectsTicketChecklistsService,
  ProjectsTicketLinksService,
  ProjectsTicketRelationsService,
  BuildTicketStatusChangedConsumerService,
} from "./tickets";
import { ProjectsReportsController } from "./projects-reports.controller";
import { ProjectsBudgetController } from "./projects-budget.controller";
import { ProjectsTemplatesController } from "./project-crud/projects-templates.controller";
import { ProjectsRoadmapController } from "./roadmap/projects-roadmap.controller";
import { ProjectsCustomFieldsController } from "./projects-custom-fields.controller";
import { ProjectsReleasesController } from "./projects-releases.controller";
import { ProjectsWebhooksController } from "./projects-webhooks.controller";
import { ProjectsAutomationsController } from "./automation/projects-automations.controller";
import { BuildMembersController } from "./build-members.controller";
import { BuildMembersService } from "./build-members.service";
import { ProjectsCustomersController } from "./projects-customers.controller";
import { ProjectsCustomersService } from "./projects-customers.service";
import { ProjectsQueryService } from "./project-crud/projects-query.service";
import { ProjectsWriteService } from "./project-crud/projects-write.service";
import { ProjectsProvisionService } from "./project-crud/projects-provision.service";
import { ProjectsMembersService } from "./projects-members.service";
import { BuildDueSweepService } from "./build-due-sweep.service";
import { BuildNotificationVisibility } from "./build-notification-visibility";
import { BuildNotificationContextService } from "./build-notification-context.service";
import { ProjectsWorkQueryService } from "./work-query/projects-work-query.service";
import { ProjectsSearchService } from "./project-crud/projects-search.service";
import { ProjectsActivityService } from "./projects-activity.service";
import { ProjectsAnalyticsService } from "./projects-analytics.service";
import { ProjectsReportsService } from "./projects-reports.service";
import { ProjectsBudgetService } from "./projects-budget.service";
import { ProjectsTemplatesService } from "./project-crud/projects-templates.service";
import { ProjectsRoadmapService } from "./roadmap/projects-roadmap.service";
import { ProjectsChangelogService } from "./projects-changelog.service";
import { ProjectsFeedbackService } from "./projects-feedback.service";
import { ProjectsCustomFieldsService } from "./projects-custom-fields.service";
import { ProjectsReleasesService } from "./projects-releases.service";
import { ProjectsWebhooksService } from "./projects-webhooks.service";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import { ProjectsAutomationsService } from "./automation/projects-automations.service";
import { ProjectsCustomStatesService } from "./projects-custom-states.service";
import { ProjectsLabelsService } from "./projects-labels.service";
import { BuildAutomationRunnerService } from "./automation/build-automation-runner.service";
import { BuildAutomationActionExecutor } from "./automation/build-automation-actions.service";
import { BuildAutomationRunHistoryService } from "./automation/build-automation-run-history.service";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { BuildReleasePublishedConsumerService } from "./build-release-published-consumer.service";
import { ProjectsSettingsIterationsController } from "./projects-settings-iterations.controller";
import { ProjectsSettingsIterationsService } from "./projects-settings-iterations.service";
import { ProjectsActivityFeedController } from "./projects-activity-feed.controller";
import { ProjectsActivityFeedService } from "./projects-activity-feed.service";

@Module({
  imports: [BillingModule, NotificationsModule, UsersModule, OutboxModule],
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
    BuildMembersController,
    ProjectsCustomersController,
    ProjectsSettingsIterationsController,
    ProjectsActivityFeedController,
    ProjectsController,
    ProjectResourcesController,
  ],
  providers: [
    BuildReleasePublishedConsumerService,
    BuildTicketStatusChangedConsumerService,
    BuildDueSweepService,
    BuildNotificationVisibility,
    BuildNotificationContextService,
    ProjectsQueryService,
    ProjectsWriteService,
    ProjectsProvisionService,
    ProjectsMembersService,
    ProjectsTicketsService,
    ProjectsTicketsDeleteService,
    ProjectsTicketsCreateService,
    ProjectsTicketsUpdateService,
    ProjectsTicketsQueryService,
    ProjectsWorkQueryService,
    ProjectsSearchService,
    ProjectsTicketsReadService,
    ProjectsTicketsDetailService,
    ProjectsTicketsTransferService,
    ProjectsTicketSubresourcesService,
    ProjectsTicketCommentsService,
    ProjectsActivityService,
    ProjectsAnalyticsService,
    ProjectsReportsService,
    ProjectsBudgetService,
    ProjectsTemplatesService,
    ProjectsRoadmapService,
    ProjectsChangelogService,
    ProjectsFeedbackService,
    ProjectsCustomFieldsService,
    ProjectsReleasesService,
    ProjectsWebhooksService,
    ProjectsWebhooksDispatchService,
    ProjectsAutomationsService,
    ProjectsCustomersService,
    BuildMembersService,
    ProjectsCustomStatesService,
    ProjectsLabelsService,
    ProjectsTicketChecklistsService,
    ProjectsTicketLinksService,
    ProjectsTicketRelationsService,
    BuildAutomationRunnerService,
    BuildAutomationActionExecutor,
    BuildAutomationRunHistoryService,
    ProjectsSettingsIterationsService,
    ProjectsActivityFeedService,
  ],
  exports: [
    BuildDueSweepService,
    ProjectsTicketsService,
    ProjectsTicketsCreateService,
    ProjectsTicketsReadService,
    ProjectsTicketsUpdateService,
    ProjectsWebhooksDispatchService,
    ProjectsQueryService,
    ProjectsProvisionService,
    ProjectsWriteService,
    ProjectsWorkQueryService,
    ProjectsTicketSubresourcesService,
    ProjectsReportsService,
  ],
})
export class ProjectsModule {}
