import { Module, forwardRef } from "@nestjs/common";
import { CrmAutomationStudioModule } from "../automation-studio/crm-automation-studio.module";
import { BillingModule } from "../../billing/core/billing.module";
import { CrmCampaignsController } from "./crm-campaigns.controller";
import { CrmCampaignsService } from "./crm-campaigns.service";
import { CrmAttributionReportService } from "./crm-attribution-report.service";
import { CrmOrganizationsController } from "./crm-organizations.controller";
import { CrmPeopleController } from "./crm-people.controller";
import { CrmSlaController } from "./crm-sla.controller";
import { CrmTerritoriesController } from "./crm-territories.controller";
import { CrmWebFormsController } from "./crm-web-forms.controller";
import { CrmRulesController } from "./crm-rules.controller";
import { CrmDashboardsController } from "./crm-dashboards.controller";
import { CrmAutomationsController } from "./crm-automations.controller";
import { CrmProductsController } from "./crm-products.controller";
import { CrmCustomer360Controller } from "./crm-customer360.controller";
import { CrmOrganizationsService } from "./crm-organizations.service";
import { CrmOrganizationsMergeService } from "./crm-organizations-merge.service";
import { CrmPeopleService } from "./crm-people.service";
import { CrmSlaService } from "./crm-sla.service";
import { CrmTerritoriesService } from "./crm-territories.service";
import { CrmWebFormsService } from "./crm-web-forms.service";
import { CrmRulesService } from "./crm-rules.service";
import { CrmSalesDashboardService } from "./crm-sales-dashboard.service";
import { CrmSupportDashboardService } from "./crm-support-dashboard.service";
import { CrmCeDashboardService } from "./crm-ce-dashboard.service";
import { CrmAutomationsService } from "./crm-automations.service";
import { CrmProductsService } from "./crm-products.service";
import { CrmOrganizationsInsightsService } from "./crm-organizations-insights.service";
import { CrmConsentModule } from "../consent/crm-consent.module";
import { CrmCustomer360Service } from "./crm-customer360.service";
import { CrmCustomer360SectionsService } from "./crm-customer360-sections.service";
import { TerritoryMatchService } from "./territory-match.service";
import { SlaResolverService } from "./sla-resolver.service";
import { NotificationsModule } from "../../notifications/notifications.module";
import { PartyModule } from "../../party/party.module";
import { CrmFollowupSweepService } from "./crm-followup-sweep.service";

@Module({
  // PartyModule for `PartyMergeService`: merging two company records is the
  // same act as merging two parties, and ticket 25 retired the second
  // implementation rather than keeping one per surface.
  imports: [forwardRef(() => CrmAutomationStudioModule), BillingModule, CrmConsentModule, NotificationsModule, PartyModule],
  controllers: [
    CrmCampaignsController,
    CrmOrganizationsController,
    CrmPeopleController,
    CrmSlaController,
    CrmTerritoriesController,
    CrmWebFormsController,
    CrmRulesController,
    CrmDashboardsController,
    CrmAutomationsController,
    CrmProductsController,
    CrmCustomer360Controller,
  ],
  providers: [
    CrmFollowupSweepService,
    CrmCampaignsService,
    CrmAttributionReportService,
    CrmOrganizationsService,
    CrmOrganizationsMergeService,
    CrmPeopleService,
    CrmSlaService,
    CrmTerritoriesService,
    CrmWebFormsService,
    CrmRulesService,
    CrmSalesDashboardService,
    CrmSupportDashboardService,
    CrmCeDashboardService,
    CrmAutomationsService,
    CrmProductsService,
    CrmOrganizationsInsightsService,
    CrmCustomer360Service,
    CrmCustomer360SectionsService,
    TerritoryMatchService,
    SlaResolverService,
  ],
  exports: [CrmAttributionReportService, TerritoryMatchService, CrmFollowupSweepService],
})
export class CrmModule {}
