import { Module } from "@nestjs/common";
import { AutomationModule } from "../../automation/automation.module";
import { CrmConsentController, CrmPublicConsentController } from "./crm-consent.controller";
import { CrmConsentService } from "./crm-consent.service";
import { CrmOutboundEmailService } from "./crm-outbound-email.service";

/**
 * Leaf module so both `CrmModule` and `CrmAutomationStudioModule` can depend on
 * the consent gate without importing each other (§24 — no cycles, no forwardRef).
 */
@Module({
  imports: [AutomationModule],
  controllers: [CrmConsentController, CrmPublicConsentController],
  providers: [CrmConsentService, CrmOutboundEmailService],
  exports: [CrmConsentService, CrmOutboundEmailService],
})
export class CrmConsentModule {}
