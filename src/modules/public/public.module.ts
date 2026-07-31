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

@Module({
  imports: [CrmAutomationStudioModule, BillingModule],
  controllers: [PublicController],
  providers: [
    RecruitmentService,
    RoadmapService,
    KbService,
    CrmService,
    IntakeService,
    OrgService,
    PublicFormsService,
    ContactService,
  ],
})
export class PublicModule {}
