import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { CrmAiController } from "./controllers/crm-ai.controller";
import { CrmCopilotController } from "./controllers/crm-copilot.controller";
import { HrAiController } from "./controllers/hr-ai.controller";
import { KbRagController } from "./controllers/kb-rag.controller";
import { ChatAssistantController } from "./controllers/chat-assistant.controller";
import { ProjectsAiController } from "./controllers/projects-ai.controller";
import { AiFeedbackController } from "./controllers/ai-feedback.controller";
import { CrmScoringService } from "./services/crm-scoring.service";
import { CrmContentService } from "./services/crm-content.service";
import { CrmBriefService } from "./services/crm-brief.service";
import { CrmMeetingBriefService } from "./services/crm-meeting-brief.service";
import { CrmNlSearchService } from "./services/crm-nl-search.service";
import { CrmTasksService } from "./services/crm-tasks.service";
import { CrmCopilotService } from "./services/crm-copilot.service";
import { CrmCopilotLeadService } from "./services/crm-copilot-lead.service";
import { CrmPipelineService } from "./services/crm-pipeline.service";
import { HrPerformanceAiService } from "./services/hr-performance-ai.service";
import { HrRecruitmentAiService } from "./services/hr-recruitment-ai.service";
import { HrPolicyAiService } from "./services/hr-policy-ai.service";
import { HrHelpdeskAiService } from "./services/hr-helpdesk-ai.service";
import { KbRagService } from "./services/kb-rag.service";
import { KbRagRetrievalService } from "./services/kb-rag-retrieval.service";
import { ChatAssistantService } from "./services/chat-assistant.service";
import { ChatHistoryService } from "./services/chat-history.service";
import { OrgFeaturesService } from "./services/org-features.service";
import { ProjectsAiService } from "./services/projects-ai.service";
import { TicketInsightsAiService } from "./services/ticket-insights-ai.service";
import { TicketTriageAiService } from "./services/ticket-triage-ai.service";
import { TicketDraftAiService } from "./services/ticket-draft-ai.service";
import { MeetingActionAiService } from "./services/meeting-action-ai.service";
import { HrCopilotTools } from "./tools/hr-copilot-tools";
import { WorkspaceCopilotTools } from "./tools/workspace-copilot-tools";
import { OpsCopilotTools } from "./tools/ops-copilot-tools";
import { WarehouseScopeService } from "../../inventory/stock-engine/warehouse-scope.service";
import { CrmCopilotTools } from "./tools/crm-copilot-tools";
import { CommsCopilotTools } from "./tools/comms-copilot-tools";
import { ProjectsCopilotTools } from "./tools/projects-copilot-tools";
import { CommsActionsTools } from "./tools/comms-actions-tools";
import { MailCopilotTools } from "./tools/mail-copilot-tools";
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
import { KbDocumentQueryModule } from "../../kb/document-query/kb-document-query.module";
import { BlogAiController } from "./controllers/blog-ai.controller";
import { BlogAiService } from "./services/blog-ai.service";
import { SurveyAiController } from "./controllers/survey-ai.controller";
import { SurveyAiService } from "./services/survey-ai.service";
import { AiRequestAbortInterceptor } from "./streaming";
import { WorkspaceInlineTools } from "./services/chat-assistant-inline-tools";
import { SelfHrTools } from "./tools/self-hr-tools";
import { SelfPayrollTools } from "./tools/self-payroll-tools";
import { SelfWorkTools } from "./tools/self-work-tools";
import { SelfCommsTools } from "./tools/self-comms-tools";
import { SelfGrowthTools } from "./tools/self-growth-tools";
import { SelfDigestTools } from "./tools/self-digest-tools";
import { SelfActionsTools } from "./tools/self-actions-tools";
import { WorkActionsTools } from "./tools/work-actions-tools";
import { ASK_OS_TOOL_PROVIDERS } from "./registry/ask-os-tool-providers";
import { AskOsToolDiscoveryService } from "./registry/ask-os-tool-discovery.service";
import { ConfirmableActionServicesCheck } from "./confirm-actions";

@Module({
  imports: [DiscoveryModule, CalendarModule, ChatModule, BillingModule, AiConfirmationModule, ProjectsModule, IntegrationsModule, ExecutiveBriefModule, AiJobsModule, MailModule, AiGatewayModule, KbDocumentQueryModule],
  controllers: [CrmAiController, CrmCopilotController, HrAiController, KbRagController, ChatAssistantController, ProjectsAiController, AiFeedbackController, MeetingsAiController, BlogAiController, SurveyAiController],
  providers: [
    CrmScoringService,
    CrmContentService,
    CrmBriefService,
    CrmMeetingBriefService,
    CrmNlSearchService,
    CrmTasksService,
    CrmCopilotService,
    CrmCopilotLeadService,
    CrmPipelineService,
    HrPerformanceAiService,
    HrRecruitmentAiService,
    HrPolicyAiService,
    HrHelpdeskAiService,
    KbRagRetrievalService,
    KbRagService,
    ChatAssistantService,
    ChatHistoryService,
    OrgFeaturesService,
    ProjectsAiService,
    TicketInsightsAiService,
    TicketTriageAiService,
    TicketDraftAiService,
    MeetingActionAiService,
    HrCopilotTools,
    WorkspaceCopilotTools,
    OpsCopilotTools,
    CrmCopilotTools,
    CommsCopilotTools,
    ProjectsCopilotTools,
    CommsActionsTools,
    MailCopilotTools,
    WorkspaceInlineTools,
    SelfHrTools,
    SelfPayrollTools,
    SelfWorkTools,
    SelfCommsTools,
    SelfGrowthTools,
    SelfDigestTools,
    SelfActionsTools,
    WorkActionsTools,
    // F2. The copilot's inventory reads apply the same warehouse scope the stock,
    // reservation and report endpoints apply, so they use the same service. It is
    // provided here rather than by importing InvStockEngineModule: both of its
    // dependencies are global, it holds no state, and importing that module would
    // drag the accounting posting graph into AiModule for one predicate builder.
    WarehouseScopeService,
    { provide: ASK_OS_TOOL_PROVIDERS, useValue: [] },
    AskOsToolDiscoveryService,
    ToolAccessService,
    ConfirmableActionServicesCheck,
    AiFeedbackService,
    MeetingsPrepService,
    BlogAiService,
    SurveyAiService,
    AiRequestAbortInterceptor,
  ],
  exports: [AiGatewayModule, OrgFeaturesService],
})
export class AiModule {}
