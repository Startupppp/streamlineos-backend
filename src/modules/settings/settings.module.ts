import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/core/billing.module";
import { OrganizationModule } from "../organization/core/organization.module";
import { AiUsageModule } from "../ai/usage/ai-usage.module";
import { CrmCustomFieldsModule } from "../crm/custom-fields/crm-custom-fields.module";
import { IntegrationsGitModule } from "../integrations/git/integrations-git.module";
import { SettingsController } from "./settings.controller";
import { SettingsDeprecatedRoutesController } from "./settings-deprecated-routes.controller";
import { SettingsService } from "./settings.service";
import { SettingsAutomationsService } from "./settings-automations.service";

@Module({
  imports: [
    BillingModule,
    OrganizationModule,
    AiUsageModule,
    CrmCustomFieldsModule,
    IntegrationsGitModule,
  ],
  controllers: [SettingsController, SettingsDeprecatedRoutesController],
  providers: [SettingsService, SettingsAutomationsService],
})
export class SettingsModule {}
