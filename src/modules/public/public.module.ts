import { Module } from "@nestjs/common";
import { CrmAutomationStudioModule } from "../crm/automation-studio/crm-automation-studio.module";
import { BillingModule } from "../billing/core/billing.module";
import { PublicController } from "./public.controller";
import { RecruitmentService } from "./recruitment.service";
import { RoadmapService } from "./roadmap.service";
import { KbService } from "./kb.service";
import { CrmService } from "./crm.service";
import { IntakeService } from "./intake.service";
import { OrgService } from "./org.service";
import { PublicFormsService } from "./public-forms.service";
import { ContactService } from "./contact.service";
import { WaitlistService } from "./waitlist.service";
import { WaitlistAdmissionService } from "./waitlist-admission.service";
import { WaitlistAdmissionController } from "./waitlist-admission.controller";
import { PlatformOperatorGuard } from "./platform-operator.guard";
import { AuthModule } from "../auth/auth.module";
import { TurnstileService } from "../../common/security/turnstile.service";
import { PublicPricingService } from "./pricing.service";

@Module({
  imports: [AuthModule, CrmAutomationStudioModule, BillingModule],
  controllers: [WaitlistAdmissionController, PublicController],
  providers: [WaitlistAdmissionService, PlatformOperatorGuard, PublicPricingService, 
    RecruitmentService,
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
