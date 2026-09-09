import { Module } from "@nestjs/common";
import { DealsController } from "./deals.controller";
import { DealsAnalyticsController } from "./deals-analytics.controller";
import { DealsApprovalsController } from "./deals-approvals.controller";
import { DealsMeetingsController } from "./deals-meetings.controller";
import { DealsCompetitorsController } from "./deals-competitors.controller";
import { DealsCompetitorSuggestionsController } from "./deals-competitor-suggestions.controller";
import { DealsStakeholdersController } from "./deals-stakeholders.controller";
import { DealsService } from "./deals.service";
import { DealsCrudService } from "./deals-crud.service";
import { DealsActivitiesService } from "./deals-activities.service";
import { DealsImportExportService } from "./deals-import-export.service";
import { DealsAnalyticsService } from "./deals-analytics.service";
import { DealsApprovalsService } from "./deals-approvals.service";
import { DealsMeetingsService } from "./deals-meetings.service";
import { DealsCompetitorsService } from "./deals-competitors.service";
import { DealsCompetitorSuggestionsService } from "./deals-competitor-suggestions.service";
import { DealsStakeholdersService } from "./deals-stakeholders.service";
import { DealsForecastModelController } from "./forecast/deals-forecast-model.controller";
import { ForecastCorpusService } from "./forecast/forecast-corpus.service";
import { ForecastTrainingService } from "./forecast/forecast-training.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { AutomationModule } from "../automation/automation.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { CrmMetadataModule } from "../crm/metadata/crm-metadata.module";
import { CrmAutomationStudioModule } from "../crm/automation-studio/crm-automation-studio.module";
import { BillingModule } from "../billing/core/billing.module";
import { ActivitiesModule } from "../activities/activities.module";
import { LifecycleModule } from "../lifecycle/lifecycle.module";

@Module({
  // `LifecycleModule` is imported, not the other way round: a won deal opens a
  // customer lifecycle, and nothing in the lifecycle book needs to move a deal.
  // Reversing the edge would close a cycle Nest could only resolve with a
  // forwardRef, which this codebase has paid for once already.
  imports: [NotificationsModule, AutomationModule, WebhooksModule, CrmMetadataModule, CrmAutomationStudioModule, BillingModule, ActivitiesModule, LifecycleModule],
  controllers: [
    DealsAnalyticsController,
    DealsApprovalsController,
    DealsMeetingsController,
    DealsCompetitorsController,
    DealsCompetitorSuggestionsController,
    DealsStakeholdersController,
    DealsForecastModelController,
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
    DealsCompetitorSuggestionsService,
    DealsStakeholdersService,
    ForecastCorpusService,
    ForecastTrainingService,
  ],
  // Ticket 12 advances a stage through the same path a person does, so the
  // ledger, the blueprint check and the cache invalidation all still happen.
  exports: [DealsService, ForecastTrainingService],
})
export class DealsModule {}
