import { Module } from "@nestjs/common";
import { CrmAiController } from "./controllers/crm-ai.controller";
import { CrmCopilotController } from "./controllers/crm-copilot.controller";
import { HrAiController } from "./controllers/hr-ai.controller";
import { KbRagController } from "./controllers/kb-rag.controller";
import { ChatAssistantController } from "./controllers/chat-assistant.controller";
import { ProjectsAiController } from "./controllers/projects-ai.controller";
import { AiFeedbackController } from "./controllers/ai-feedback.controller";
import { EmbeddingsService } from "./providers/embeddings.service";
import { CrmScoringService } from "./services/crm-scoring.service";
import { CrmContentService } from "./services/crm-content.service";
import { CrmBriefService } from "./services/crm-brief.service";
import { CrmTasksService } from "./services/crm-tasks.service";
import { CrmCopilotService } from "./services/crm-copilot.service";
import { CrmPipelineService } from "./services/crm-pipeline.service";
import { HrPerformanceAiService } from "./services/hr-performance-ai.service";
import { HrRecruitmentAiService } from "./services/hr-recruitment-ai.service";
import { HrPolicyAiService } from "./services/hr-policy-ai.service";
import { HrHelpdeskAiService } from "./services/hr-helpdesk-ai.service";
import { KbRagService } from "./services/kb-rag.service";
import { ChatAssistantService } from "./services/chat-assistant.service";
import { ChatHistoryService } from "./services/chat-history.service";
import { OrgFeaturesService } from "./services/org-features.service";
import { ProjectsAiService } from "./services/projects-ai.service";
import { TicketInsightsAiService } from "./services/ticket-insights-ai.service";
import { TicketTriageAiService } from "./services/ticket-triage-ai.service";
import { MeetingActionAiService } from "./services/meeting-action-ai.service";
import { HrCopilotTools } from "./hr-copilot-tools";
import { WorkspaceCopilotTools } from "./workspace-copilot-tools";
import { OpsCopilotTools } from "./ops-copilot-tools";
import { CrmCopilotTools } from "./crm-copilot-tools";
import { CommsCopilotTools } from "./comms-copilot-tools";
import { ProjectsCopilotTools } from "./projects-copilot-tools";
import { CommsActionsTools } from "./comms-actions-tools";
import { MailCopilotTools } from "./mail-copilot-tools";
import { ToolAccessService } from "./tool-access.service";
import { AiFeedbackService } from "./services/ai-feedback.service";
import { CalendarModule } from "../../calendar/calendar.module";
import { ChatModule } from "../../chat/chat.module";
import { BillingModule } from "../../billing/core/billing.module";
import { AiConfirmationModule } from "../confirmation/ai-confirmation.module";
import { ProjectsModule } from "../../build/core/projects.module";
import { IntegrationsModule } from "../../integrations/core/integrations.module";
import { MeetingsAiController } from "./controllers/meetings-ai.controller";
import { MeetingsPrepService } from "./services/meetings-prep.service";
import { ExecutiveBriefModule } from "./executive-brief/executive-brief.module";
import { AiJobsModule } from "../jobs/ai-jobs.module";
import { MailModule } from "../../mail/mail.module";
import { AiGatewayModule } from "./gateway/ai-gateway.module";
import { BlogAiController } from "./controllers/blog-ai.controller";
import { BlogAiService } from "./services/blog-ai.service";
import { SurveyAiController } from "./controllers/survey-ai.controller";
import { SurveyAiService } from "./services/survey-ai.service";

@Module({
  imports: [CalendarModule, ChatModule, BillingModule, AiConfirmationModule, ProjectsModule, IntegrationsModule, ExecutiveBriefModule, AiJobsModule, MailModule, AiGatewayModule],
  controllers: [CrmAiController, CrmCopilotController, HrAiController, KbRagController, ChatAssistantController, ProjectsAiController, AiFeedbackController, MeetingsAiController, BlogAiController, SurveyAiController],
  providers: [
    EmbeddingsService,
    CrmScoringService,
    CrmContentService,
    CrmBriefService,
    CrmTasksService,
    CrmCopilotService,
    CrmPipelineService,
    HrPerformanceAiService,
    HrRecruitmentAiService,
    HrPolicyAiService,
    HrHelpdeskAiService,
    KbRagService,
    ChatAssistantService,
    ChatHistoryService,
    OrgFeaturesService,
    ProjectsAiService,
    TicketInsightsAiService,
    TicketTriageAiService,
    MeetingActionAiService,
    HrCopilotTools,
    WorkspaceCopilotTools,
    OpsCopilotTools,
    CrmCopilotTools,
    CommsCopilotTools,
    ProjectsCopilotTools,
    CommsActionsTools,
    MailCopilotTools,
    ToolAccessService,
    AiFeedbackService,
    MeetingsPrepService,
    BlogAiService,
    SurveyAiService,
  ],
  exports: [AiGatewayModule, EmbeddingsService, OrgFeaturesService],
})
export class AiModule {}
