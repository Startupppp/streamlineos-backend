import { Module } from "@nestjs/common";
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
import { TerritoryMatchService } from "./territory-match.service";
import { SlaResolverService } from "./sla-resolver.service";

@Module({
  controllers: [
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
    TerritoryMatchService,
    SlaResolverService,
  ],
})
export class CrmModule {}
