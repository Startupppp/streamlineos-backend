import { Module } from "@nestjs/common";
import { DealsController } from "./deals.controller";
import { DealsAnalyticsController } from "./deals-analytics.controller";
import { DealsApprovalsController } from "./deals-approvals.controller";
import { DealsMeetingsController } from "./deals-meetings.controller";
import { DealsCompetitorsController } from "./deals-competitors.controller";
import { DealsStakeholdersController } from "./deals-stakeholders.controller";
import { DealsService } from "./deals.service";
import { DealsCrudService } from "./deals-crud.service";
import { DealsActivitiesService } from "./deals-activities.service";
import { DealsImportExportService } from "./deals-import-export.service";
import { DealsAnalyticsService } from "./deals-analytics.service";
import { DealsApprovalsService } from "./deals-approvals.service";
import { DealsMeetingsService } from "./deals-meetings.service";
import { DealsCompetitorsService } from "./deals-competitors.service";
import { DealsStakeholdersService } from "./deals-stakeholders.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { AutomationModule } from "../automation/automation.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { CrmMetadataModule } from "../crm/metadata/crm-metadata.module";
import { CrmAutomationStudioModule } from "../crm/automation-studio/crm-automation-studio.module";
import { BillingModule } from "../billing/core/billing.module";
import { ActivitiesModule } from "../activities/activities.module";

@Module({
  imports: [NotificationsModule, AutomationModule, WebhooksModule, CrmMetadataModule, CrmAutomationStudioModule, BillingModule, ActivitiesModule],
  controllers: [
    DealsAnalyticsController,
    DealsApprovalsController,
    DealsMeetingsController,
    DealsCompetitorsController,
    DealsStakeholdersController,
    DealsController,
  ],
  providers: [
    DealsCrudService,
    DealsActivitiesService,
    DealsImportExportService,
    DealsService,
    DealsAnalyticsService,
    DealsApprovalsService,
    DealsMeetingsService,
    DealsCompetitorsService,
    DealsStakeholdersService,
  ],
  // Ticket 12 advances a stage through the same path a person does, so the
  // ledger, the blueprint check and the cache invalidation all still happen.
  exports: [DealsService],
})
export class DealsModule {}
