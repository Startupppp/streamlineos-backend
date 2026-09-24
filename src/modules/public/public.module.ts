import { Module } from "@nestjs/common";
import { CrmAutomationStudioModule } from "../crm/automation-studio/crm-automation-studio.module";
import { BillingModule } from "../billing/core/billing.module";
import { HrRecruitmentModule } from "../hr/recruitment/hr-recruitment.module";
import { BuildFormsModule } from "../build/forms/build-forms.module";
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
import { WaitlistAdmissionService } from "./waitlist-admission.service";
import { WaitlistAdmissionController } from "./waitlist-admission.controller";
import { PlatformOperatorGuard } from "./platform-operator.guard";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { TurnstileService } from "../../common/security/turnstile.service";
import { PublicPricingService } from "./pricing.service";

@Module({
  imports: [
    AuthModule,
    CrmAutomationStudioModule,
    BillingModule,
    /* Both sides added one. Taking either alone drops the other's providers. */
    HrRecruitmentModule,
    NotificationsModule,
    BuildFormsModule,
  ],
  controllers: [WaitlistAdmissionController, PublicController],
  providers: [
    PublicCareersService,
    PublicOffersService,
    PublicReferrersService,
    WaitlistAdmissionService,
    PlatformOperatorGuard,
    PublicPricingService,
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
