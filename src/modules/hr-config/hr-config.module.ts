import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { BillingModule } from "../billing/billing.module";
import { HrDepartmentsController } from "./hr-departments.controller";
import { HrHolidaysController } from "./hr-holidays.controller";
import { HrLeaveBlackoutController } from "./hr-leave-blackout.controller";
import { HrDocumentTypesController } from "./hr-document-types.controller";
import { HrDocumentTemplatesController } from "./hr-document-templates.controller";
import { HrEmailTemplatesController } from "./hr-email-templates.controller";
import { HrSalaryStructuresController } from "./hr-salary-structures.controller";
import { HrCareerLaddersController } from "./hr-career-ladders.controller";
import { HrLearningPathsController } from "./hr-learning-paths.controller";
import { HrSkillsController } from "./hr-skills.controller";
import { HrCertificationsController } from "./hr-certifications.controller";
import { HrInterviewQuestionsController } from "./hr-interview-questions.controller";
import { HrHandbookController } from "./hr-handbook.controller";
import { HrNotificationPreferencesController } from "./hr-notification-preferences.controller";
import { HrDepartmentsService } from "./hr-departments.service";
import { HrHolidaysService } from "./hr-holidays.service";
import { HrLeaveBlackoutService } from "./hr-leave-blackout.service";
import { HrDocumentTypesService } from "./hr-document-types.service";
import { HrDocumentTemplatesService } from "./hr-document-templates.service";
import { HrEmailTemplatesService } from "./hr-email-templates.service";
import { HrSalaryStructuresService } from "./hr-salary-structures.service";
import { HrGrowthService } from "./hr-growth.service";
import { HrCompetenciesService } from "./hr-competencies.service";
import { HrInterviewQuestionsService } from "./hr-interview-questions.service";
import { HrHandbookService } from "./hr-handbook.service";
import { HrNotificationPreferencesService } from "./hr-notification-preferences.service";

@Module({
  imports: [AiModule, BillingModule],
  controllers: [
    HrDepartmentsController,
    HrHolidaysController,
    HrLeaveBlackoutController,
    HrDocumentTypesController,
    HrDocumentTemplatesController,
    HrEmailTemplatesController,
    HrSalaryStructuresController,
    HrCareerLaddersController,
    HrLearningPathsController,
    HrSkillsController,
    HrCertificationsController,
    HrInterviewQuestionsController,
    HrHandbookController,
    HrNotificationPreferencesController,
  ],
  providers: [
    HrDepartmentsService,
    HrHolidaysService,
    HrLeaveBlackoutService,
    HrDocumentTypesService,
    HrDocumentTemplatesService,
    HrEmailTemplatesService,
    HrSalaryStructuresService,
    HrGrowthService,
    HrCompetenciesService,
    HrInterviewQuestionsService,
    HrHandbookService,
    HrNotificationPreferencesService,
  ],
})
export class HrConfigModule {}
