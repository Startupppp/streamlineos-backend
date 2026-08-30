import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/core/billing.module";
import { SettingsController } from "./settings.controller";
import { SettingsService } from "./settings.service";
import { SettingsAutomationsService } from "./settings-automations.service";
import { SettingsCustomFieldsService } from "./settings-custom-fields.service";

@Module({
  imports: [BillingModule],
  controllers: [SettingsController],
  providers: [SettingsService, SettingsAutomationsService, SettingsCustomFieldsService],
})
export class SettingsModule {}
