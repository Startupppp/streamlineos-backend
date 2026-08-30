import { Module } from "@nestjs/common";
import { BillingModule } from "../../billing/core/billing.module";
import { KbModule } from "../../kb/kb.module";
import { RealtimeModule } from "../../realtime/realtime.module";
import { AutomationModule } from "../../automation/automation.module";
import { AiModule } from "../../ai/core/ai.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { OutboxModule } from "../../common/outbox/outbox.module";
import { SupportKbController } from "./support-kb.controller";
import { SupportMacrosController } from "./support-macros.controller";
import { SupportWorkspaceController } from "./support-workspace.controller";
import { SupportRealtimeController } from "./support-realtime.controller";
import { SupportSlaController } from "./support-sla.controller";
import { SupportPortalController } from "./support-portal.controller";
import { SupportChannelsController } from "./support-channels.controller";
import { SupportAutomationsController } from "./support-automations.controller";
import { SupportCsatController } from "./support-csat.controller";
import { SupportAiController } from "./support-ai.controller";
import { SupportReportsController } from "./support-reports.controller";
import { SupportCustomFieldsController } from "./support-custom-fields.controller";
import { SupportTicketsController } from "./support-tickets.controller";
import { SupportKbService } from "./support-kb.service";
import { SupportMacrosService } from "./support-macros.service";
import { SupportWorkspaceService } from "./support-workspace.service";
import { SupportRealtimeService } from "./support-realtime.service";
import { SupportSlaService } from "./support-sla.service";
import { SupportPortalService } from "./support-portal.service";
import { SupportChannelsService } from "./support-channels.service";
import { SupportCsatService } from "./support-csat.service";
import { SupportAiService } from "./support-ai.service";
import { SupportAiSettingsService } from "./support-ai-settings.service";
import { SupportAiEmbeddingsHelper } from "./support-ai-embeddings.helper";
import { SupportAiReportHelper } from "./support-ai-report.helper";
import { SupportReportsService } from "./support-reports.service";
import { SupportCustomFieldsService } from "./support-custom-fields.service";
import { SupportSettingsAuditService } from "./support-settings-audit.service";
import { SupportTicketsService } from "./support-tickets.service";
import { SupportTicketActivityService } from "./support-ticket-activity.service";
import { SupportTicketMessagesService } from "./support-ticket-messages.service";
import { SupportTicketOperationsService } from "./support-ticket-operations.service";
import { SupportNotificationsService } from "./support-notifications.service";
import { SupportMentionsService } from "./support-mentions.service";
import { SupportDraftsService } from "./support-drafts.service";
import { SupportIntegrationsService } from "./support-integrations.service";
import { SupportTicketResolvedConsumer } from "./support-ticket-resolved-consumer.service";

@Module({
  imports: [BillingModule, KbModule, RealtimeModule, AutomationModule, AiModule, NotificationsModule, OutboxModule],
  controllers: [
    SupportKbController,
    SupportMacrosController,
    SupportWorkspaceController,
    SupportRealtimeController,
    SupportSlaController,
    SupportChannelsController,
    SupportAutomationsController,
    SupportCsatController,
    SupportAiController,
    SupportReportsController,
    SupportCustomFieldsController,
    SupportPortalController,
    SupportTicketsController,
  ],
  providers: [
    SupportKbService,
    SupportMacrosService,
    SupportWorkspaceService,
    SupportRealtimeService,
    SupportSlaService,
    SupportPortalService,
    SupportChannelsService,
    SupportCsatService,
    SupportAiService,
    SupportAiSettingsService,
    SupportAiEmbeddingsHelper,
    SupportAiReportHelper,
    SupportReportsService,
    SupportCustomFieldsService,
    SupportSettingsAuditService,
    SupportTicketActivityService,
    SupportTicketMessagesService,
    SupportTicketOperationsService,
    SupportTicketsService,
    SupportNotificationsService,
    SupportMentionsService,
    SupportDraftsService,
    SupportIntegrationsService,
    SupportTicketResolvedConsumer,
  ],
  exports: [SupportSlaService, SupportTicketsService],
})
export class SupportModule {}
