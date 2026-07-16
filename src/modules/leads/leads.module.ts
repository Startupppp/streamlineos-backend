import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { AutomationModule } from "../automation/automation.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { CrmMetadataModule } from "../crm-metadata/crm-metadata.module";
import { CrmModule } from "../crm/crm.module";
import { CrmAutomationStudioModule } from "../crm-automation-studio/crm-automation-studio.module";
import { BillingModule } from "../billing/billing.module";
import { LeadsController } from "./leads.controller";
import { LeadsIngestController } from "./leads.ingest.controller";
import { LeadsReportsController } from "./leads-reports.controller";
import { LeadsDetailController } from "./leads-detail.controller";
import { LeadsOpsController } from "./leads-ops.controller";
import { LeadsService } from "./leads.service";
import { LeadsBoardService } from "./leads-board.service";
import { LeadsReportsService } from "./leads-reports.service";
import { LeadsReportsTeamService } from "./leads-reports-team.service";
import { LeadsExportsService } from "./leads-exports.service";
import { LeadsDetailService } from "./leads-detail.service";
import { LeadStatusService } from "./lead-status.service";
import { LeadsOpsService } from "./leads-ops.service";
import { LeadNotificationAiService } from "./lead-notification-ai.service";

@Module({
  imports: [NotificationsModule, AutomationModule, WebhooksModule, CrmMetadataModule, CrmModule, CrmAutomationStudioModule, BillingModule],
  controllers: [
    LeadsReportsController,
    LeadsOpsController,
    LeadsDetailController,
    LeadsController,
    LeadsIngestController,
  ],
  providers: [
    LeadsBoardService,
    LeadsService,
    LeadsReportsService,
    LeadsReportsTeamService,
    LeadsExportsService,
    LeadsDetailService,
    LeadStatusService,
    LeadsOpsService,
    LeadNotificationAiService,
  ],
  exports: [LeadsService, LeadsDetailService],
})
export class LeadsModule {}
