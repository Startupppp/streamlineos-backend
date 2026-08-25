import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/core/billing.module";
import { CrmAutomationStudioModule } from "../crm/automation-studio/crm-automation-studio.module";
import { QuotesController } from "./quotes.controller";
import { QuotesService } from "./quotes.service";
import { QuotesLifecycleService } from "./quotes-lifecycle.service";

/**
 * Exports both services so the autonomy module can draft a quote and send one.
 *
 * CLAUDE.md §1: cross-module access goes through the other module's service,
 * never its repository or schema — which requires the service to actually leave
 * the module.
 */
@Module({
  imports: [BillingModule, CrmAutomationStudioModule],
  controllers: [QuotesController],
  providers: [QuotesService, QuotesLifecycleService],
  exports: [QuotesService, QuotesLifecycleService],
})
export class QuotesModule {}
