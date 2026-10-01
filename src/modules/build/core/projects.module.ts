import { Module } from "@nestjs/common";
import { BillingModule } from "../../billing/core/billing.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { UsersModule } from "../../users/users.module";
import { ProjectsController } from "./projects.controller";
import { ProjectResourcesController } from "./project-crud/project-resources.controller";
import {
  ProjectsTicketsController,
  ProjectsTicketCommentsController,
  ProjectsTicketChecklistsController,
  ProjectsTicketAssociationsController,
  ProjectsTicketsService,
  ProjectsTicketsDeleteService,
  ProjectsTicketsCreateService,
  BuildTicketCreationService,
  ProjectsTicketsUpdateService,
  ProjectsTicketsQueryService,
  ProjectsTicketsReadService,
  ProjectsTicketsDetailService,
  ProjectsTicketsTransferService,
  ProjectsTicketCommentsService,
  ProjectsTicketChecklistsService,
  ProjectsTicketLinksService,
  ProjectsTicketRelationsService,
  ProjectsTicketWatchersService,
  ProjectsTicketLabelsService,
  ProjectsTicketSubresourcesService,
  BuildTicketStatusChangedConsumerService,
  ProjectsTicketsRestoreService,
} from "./tickets";
import { ProjectsLabelsService } from "./lib/projects-labels.service";
import { ProjectsReportsController } from "./analytics/projects-reports.controller";
import { ProjectsBudgetController } from "./budget/projects-budget.controller";
import { ProjectsTemplatesController } from "./project-crud/projects-templates.controller";
import { ProjectsRoadmapController } from "./roadmap/projects-roadmap.controller";
import { ProjectsCustomFieldsController } from "./custom-fields/projects-custom-fields.controller";
import { ProjectsReleasesController } from "./releases/projects-releases.controller";
import { ProjectsWebhooksController } from "./webhooks/projects-webhooks.controller";
import { ProjectsAutomationsController } from "./automation/projects-automations.controller";
import { BuildMembersController } from "./members/build-members.controller";
import { BuildMembersService } from "./members/build-members.service";
import { ProjectsCustomersController } from "./customers/projects-customers.controller";
import { ProjectsCustomersService } from "./customers/projects-customers.service";
import { ProjectsQueryService } from "./project-crud/projects-query.service";
import { ProjectsWriteService } from "./project-crud/projects-write.service";
import { ProjectsRestoreService } from "./project-crud/projects-restore.service";
import { ProjectsProvisionService } from "./project-crud/projects-provision.service";
import { ProjectsMembersService } from "./members/projects-members.service";
import { BuildDueSweepService } from "./due-sweep/build-due-sweep.service";
import { BuildNotificationVisibility } from "./notifications/build-notification-visibility";
import { BuildNotificationContextService } from "./notifications/build-notification-context.service";
import { ProjectsWorkQueryService } from "./work-query/projects-work-query.service";
import { ProjectsSearchService } from "./project-crud/projects-search.service";
import { ProjectsActivityService } from "./activity/projects-activity.service";
import { ProjectsAnalyticsService } from "./analytics/projects-analytics.service";
import { ProjectsReportsService } from "./analytics/projects-reports.service";
import { ProjectsBudgetService } from "./budget/projects-budget.service";
import { ProjectsTemplatesService } from "./project-crud/projects-templates.service";
import { ProjectsRoadmapService } from "./roadmap/projects-roadmap.service";
import { ProjectsChangelogService } from "./activity/projects-changelog.service";
import { ProjectsFeedbackService } from "./feedback/projects-feedback.service";
import { ProjectsCustomFieldsService } from "./custom-fields/projects-custom-fields.service";
import { ProjectsReleasesService } from "./releases/projects-releases.service";
import { ProjectsWebhooksService } from "./webhooks/projects-webhooks.service";
import { ProjectsWebhooksDispatchService } from "./webhooks/projects-webhooks-dispatch.service";
import { ProjectsAutomationsService } from "./automation/projects-automations.service";
import { ProjectsCustomStatesService } from "./custom-states/projects-custom-states.service";
import { BuildAutomationRunnerService } from "./automation/build-automation-runner.service";
import { BuildAutomationActionExecutor } from "./automation/build-automation-actions.service";
import { BuildAutomationRunHistoryService } from "./automation/build-automation-run-history.service";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { BuildReleasePublishedConsumerService } from "./releases/build-release-published-consumer.service";
import { BuildBlockerCreatedConsumerService } from "./tickets/build-blocker-created-consumer.service";
import { ProjectsSettingsIterationsController } from "./settings/projects-settings-iterations.controller";
import { ProjectsSettingsIterationsService } from "./settings/projects-settings-iterations.service";
import { ProjectsActivityFeedController } from "./activity/projects-activity-feed.controller";
import { ProjectsActivityFeedService } from "./activity/projects-activity-feed.service";

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
    BuildBlockerCreatedConsumerService,
    BuildDueSweepService,
    BuildNotificationVisibility,
    BuildNotificationContextService,
    ProjectsQueryService,
    ProjectsWriteService,
    ProjectsRestoreService,
    ProjectsTicketsRestoreService,
    ProjectsProvisionService,
    ProjectsMembersService,
    ProjectsTicketsService,
    ProjectsTicketsDeleteService,
    ProjectsTicketsCreateService,
    BuildTicketCreationService,
    ProjectsTicketsUpdateService,
    ProjectsTicketsQueryService,
    ProjectsWorkQueryService,
    ProjectsSearchService,
    ProjectsTicketsReadService,
    ProjectsTicketsDetailService,
    ProjectsTicketsTransferService,
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
    ProjectsTicketWatchersService,
    ProjectsTicketLabelsService,
    ProjectsTicketSubresourcesService,
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
    BuildTicketCreationService,
    ProjectsTicketsReadService,
    ProjectsTicketsUpdateService,
    ProjectsWebhooksDispatchService,
    ProjectsQueryService,
    ProjectsProvisionService,
    ProjectsWriteService,
    ProjectsRestoreService,
    ProjectsTicketsRestoreService,
    ProjectsWorkQueryService,
    ProjectsReportsService,
    ProjectsTicketSubresourcesService,
  ],
})
export class ProjectsModule {}
