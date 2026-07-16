import { Module, forwardRef } from "@nestjs/common";
import { CrmAutomationStudioModule } from "../crm-automation-studio/crm-automation-studio.module";
import { BillingModule } from "../billing/billing.module";
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
import { CrmPeopleService } from "./crm-people.service";
import { CrmSlaService } from "./crm-sla.service";
import { CrmTerritoriesService } from "./crm-territories.service";
import { CrmWebFormsService } from "./crm-web-forms.service";
import { CrmRulesService } from "./crm-rules.service";
import { CrmSalesDashboardService } from "./crm-sales-dashboard.service";
import { CrmSupportDashboardService } from "./crm-support-dashboard.service";
import { CrmAutomationsService } from "./crm-automations.service";
import { CrmProductsService } from "./crm-products.service";
import { CrmOrgMergeService } from "./crm-org-merge.service";
import { CrmCustomer360Service } from "./crm-customer360.service";
import { CrmCustomer360SectionsService } from "./crm-customer360-sections.service";
import { TerritoryMatchService } from "./territory-match.service";
import { SlaResolverService } from "./sla-resolver.service";

@Module({
  imports: [forwardRef(() => CrmAutomationStudioModule), BillingModule],
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
    CrmCampaignsService,
    CrmAttributionReportService,
    CrmOrganizationsService,
    CrmPeopleService,
    CrmSlaService,
    CrmTerritoriesService,
    CrmWebFormsService,
    CrmRulesService,
    CrmSalesDashboardService,
    CrmSupportDashboardService,
    CrmAutomationsService,
    CrmProductsService,
    CrmOrgMergeService,
    CrmCustomer360Service,
    CrmCustomer360SectionsService,
    TerritoryMatchService,
    SlaResolverService,
  ],
  exports: [CrmAttributionReportService, TerritoryMatchService],
})
export class CrmModule {}
