import { Module } from "@nestjs/common";
import { CrmAutomationStudioModule } from "../crm/automation-studio/crm-automation-studio.module";
import { BillingModule } from "../billing/core/billing.module";
import { PublicController } from "./public.controller";
import { PublicCareersService } from "./public-careers.service";
import { PublicOffersService } from "./public-offers.service";
import { PublicReferrersService } from "./public-referrers.service";
import { RoadmapService } from "./roadmap.service";
import { KbService } from "./kb.service";
import { CrmService } from "./crm.service";
import { IntakeService } from "./intake.service";
import { OrgService } from "./org.service";
import { PublicFormsService } from "./public-forms.service";
import { ContactService } from "./contact.service";
import { WaitlistService } from "./waitlist.service";
import { TurnstileService } from "../../common/security/turnstile.service";

@Module({
  imports: [CrmAutomationStudioModule, BillingModule],
  controllers: [PublicController],
  providers: [
    PublicCareersService,
    PublicOffersService,
    PublicReferrersService,
    RoadmapService,
    KbService,
    CrmService,
    IntakeService,
    OrgService,
    PublicFormsService,
    ContactService,
    WaitlistService,
    TurnstileService,
  ],
})
export class PublicModule {}
