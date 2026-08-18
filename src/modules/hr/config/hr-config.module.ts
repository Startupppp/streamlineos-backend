import { Module } from "@nestjs/common";
import { AiModule } from "../../ai/core/ai.module";
import { BillingModule } from "../../billing/core/billing.module";
import { OrgHierarchyModule } from "../../organization/hierarchy/org-hierarchy.module";
import { HrDepartmentsController } from "./hr-departments.controller";
import { HrHolidaysController } from "./hr-holidays.controller";
import { HrLeaveBlackoutController } from "./hr-leave-blackout.controller";
import { HrDocumentTypesController } from "./hr-document-types.controller";
import { HrDocumentTemplatesController } from "./hr-document-templates.controller";
import { HrEmailTemplatesController } from "./hr-email-templates.controller";
import { HrSalaryStructuresController } from "./hr-salary-structures.controller";
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
import { HrInterviewQuestionsService } from "./hr-interview-questions.service";
import { HrHandbookService } from "./hr-handbook.service";
import { HrNotificationPreferencesService } from "./hr-notification-preferences.service";

@Module({
  imports: [AiModule, BillingModule, OrgHierarchyModule],
  controllers: [
    HrDepartmentsController,
    HrHolidaysController,
    HrLeaveBlackoutController,
    HrDocumentTypesController,
    HrDocumentTemplatesController,
    HrEmailTemplatesController,
    HrSalaryStructuresController,
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
    HrInterviewQuestionsService,
    HrHandbookService,
    HrNotificationPreferencesService,
  ],
  exports: [HrHolidaysService],
})
export class HrConfigModule {}
