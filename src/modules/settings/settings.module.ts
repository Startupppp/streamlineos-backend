import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { SettingsController } from "./settings.controller";
import { SettingsService } from "./settings.service";

@Module({ imports: [BillingModule], controllers: [SettingsController], providers: [SettingsService] })
export class SettingsModule {}
