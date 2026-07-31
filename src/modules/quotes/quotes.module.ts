import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/core/billing.module";
import { CrmAutomationStudioModule } from "../crm/automation-studio/crm-automation-studio.module";
import { QuotesController } from "./quotes.controller";
import { QuotesService } from "./quotes.service";
import { QuotesLifecycleService } from "./quotes-lifecycle.service";

@Module({ imports: [BillingModule, CrmAutomationStudioModule], controllers: [QuotesController], providers: [QuotesService, QuotesLifecycleService] })
export class QuotesModule {}
