import { Module } from "@nestjs/common";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { LeadsModule } from "../leads/leads.module";
import { TasksModule } from "../tasks/tasks.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { BillingModule } from "../billing/core/billing.module";
import { SurveysController } from "./surveys.controller";
import { SurveyBuilderController } from "./survey-builder.controller";
import { SurveyCollectorsController } from "./survey-collectors.controller";
import { SurveyParticipantsController } from "./survey-participants.controller";
import { SurveyPublicController } from "./survey-public.controller";
import { SurveyAssessmentController } from "./survey-assessment.controller";
import { SurveyLiveSessionController } from "./survey-live-session.controller";
import { SurveyAnalyticsController } from "./survey-analytics.controller";
import { SurveyAutomationController } from "./survey-automation.controller";
import { SurveyFormsService } from "./survey-forms.service";
import { SurveyVersionService } from "./survey-version.service";
import { SurveyBuilderService } from "./survey-builder.service";
import { SurveyLogicService } from "./survey-logic.service";
import { SurveyCollectorService } from "./survey-collector.service";
import { SurveyParticipantService } from "./survey-participant.service";
import { SurveyResponseService } from "./survey-response.service";
import { SurveyAssessmentService } from "./survey-assessment.service";
import { SurveyLiveSessionService } from "./survey-live-session.service";
import { SurveyLiveParticipantService } from "./survey-live-participant.service";
import { SurveyAnalyticsService } from "./survey-analytics.service";
import { SurveyAutomationService } from "./survey-automation.service";
import { SurveyLeadAutomationService } from "./survey-lead-automation.service";
import { SurveyExportService } from "./survey-export.service";
import { SurveyTemplateService } from "./survey-template.service";

@Module({
  imports: [WebhooksModule, LeadsModule, TasksModule, NotificationsModule, BillingModule],
  controllers: [
    SurveysController,
    SurveyBuilderController,
    SurveyCollectorsController,
    SurveyParticipantsController,
    SurveyPublicController,
    SurveyAssessmentController,
    SurveyLiveSessionController,
    SurveyAnalyticsController,
    SurveyAutomationController,
  ],
  providers: [
    SurveyFormsService,
    SurveyVersionService,
    SurveyBuilderService,
    SurveyLogicService,
    SurveyCollectorService,
    SurveyParticipantService,
    SurveyResponseService,
    SurveyAssessmentService,
    SurveyLiveSessionService,
    SurveyLiveParticipantService,
    SurveyAnalyticsService,
    SurveyAutomationService,
    SurveyLeadAutomationService,
    SurveyExportService,
    SurveyTemplateService,
  ],
})
export class SurveysModule {}
