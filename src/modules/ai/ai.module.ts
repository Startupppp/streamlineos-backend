import { forwardRef, Module } from "@nestjs/common";
import { CrmAiController } from "./controllers/crm-ai.controller";
import { CrmCopilotController } from "./controllers/crm-copilot.controller";
import { HrAiController } from "./controllers/hr-ai.controller";
import { KbRagController } from "./controllers/kb-rag.controller";
import { ChatAssistantController } from "./controllers/chat-assistant.controller";
import { ProjectsAiController } from "./controllers/projects-ai.controller";
import { AiFeedbackController } from "./controllers/ai-feedback.controller";
import { LlmService } from "./providers/llm.service";
import { EmbeddingsService } from "./providers/embeddings.service";
import { CrmScoringService } from "./services/crm-scoring.service";
import { CrmContentService } from "./services/crm-content.service";
import { CrmBriefService } from "./services/crm-brief.service";
import { CrmTasksService } from "./services/crm-tasks.service";
import { CrmCopilotService } from "./services/crm-copilot.service";
import { CrmPipelineService } from "./services/crm-pipeline.service";
import { HrAiService } from "./services/hr-ai.service";
import { KbRagService } from "./services/kb-rag.service";
import { ChatAssistantService } from "./services/chat-assistant.service";
import { ChatHistoryService } from "./services/chat-history.service";
import { AiUsageService } from "./services/ai-usage.service";
import { OrgFeaturesService } from "./services/org-features.service";
import { ProjectsAiService } from "./services/projects-ai.service";
import { TicketAiService } from "./services/ticket-ai.service";
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
import { CalendarModule } from "../calendar/calendar.module";
import { ChatModule } from "../chat/chat.module";
import { AiGatewayService } from "./gateway/ai-gateway.service";
import { AI_CREDIT_LEDGER } from "./gateway/credit-ledger.interface";
import { BillingModule } from "../billing/billing.module";
import { AiCreditsService } from "../billing/ai-credits.service";
import { AiConfirmationModule } from "../ai-confirmation/ai-confirmation.module";
import { ProjectsModule } from "../projects/projects.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { MeetingsAiController } from "./controllers/meetings-ai.controller";
import { MeetingsPrepService } from "./services/meetings-prep.service";
import { ExecutiveBriefModule } from "./executive-brief/executive-brief.module";
import { AiJobsModule } from "../ai-jobs/ai-jobs.module";
import { MailModule } from "../mail/mail.module";
import { BlogAiController } from "./controllers/blog-ai.controller";
import { BlogAiService } from "./services/blog-ai.service";
import { SurveyAiController } from "./controllers/survey-ai.controller";
import { SurveyAiService } from "./services/survey-ai.service";

@Module({
  imports: [CalendarModule, ChatModule, BillingModule, AiConfirmationModule, ProjectsModule, IntegrationsModule, ExecutiveBriefModule, AiJobsModule, forwardRef(() => MailModule)],
  controllers: [CrmAiController, CrmCopilotController, HrAiController, KbRagController, ChatAssistantController, ProjectsAiController, AiFeedbackController, MeetingsAiController, BlogAiController, SurveyAiController],
  providers: [
    LlmService,
    EmbeddingsService,
    CrmScoringService,
    CrmContentService,
    CrmBriefService,
    CrmTasksService,
    CrmCopilotService,
    CrmPipelineService,
    HrAiService,
    KbRagService,
    ChatAssistantService,
    ChatHistoryService,
    AiUsageService,
    OrgFeaturesService,
    ProjectsAiService,
    TicketAiService,
    HrCopilotTools,
    WorkspaceCopilotTools,
    OpsCopilotTools,
    CrmCopilotTools,
    CommsCopilotTools,
    ProjectsCopilotTools,
    CommsActionsTools,
    MailCopilotTools,
    ToolAccessService,
    AiGatewayService,
    AiFeedbackService,
    MeetingsPrepService,
    BlogAiService,
    SurveyAiService,
    { provide: AI_CREDIT_LEDGER, useExisting: AiCreditsService },
  ],
  exports: [LlmService, EmbeddingsService, AiUsageService, OrgFeaturesService, AiGatewayService],
})
export class AiModule {}
