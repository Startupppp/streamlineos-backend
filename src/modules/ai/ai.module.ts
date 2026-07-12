import { Module } from "@nestjs/common";
import { CrmAiController } from "./controllers/crm-ai.controller";
import { CrmCopilotController } from "./controllers/crm-copilot.controller";
import { HrAiController } from "./controllers/hr-ai.controller";
import { KbRagController } from "./controllers/kb-rag.controller";
import { ChatAssistantController } from "./controllers/chat-assistant.controller";
import { ProjectsAiController } from "./controllers/projects-ai.controller";
import { LlmService } from "./providers/llm.service";
import { EmbeddingsService } from "./providers/embeddings.service";
import { CrmScoringService } from "./services/crm-scoring.service";
import { CrmContentService } from "./services/crm-content.service";
import { CrmBriefService } from "./services/crm-brief.service";
import { CrmTasksService } from "./services/crm-tasks.service";
import { CrmCopilotService } from "./services/crm-copilot.service";
import { HrAiService } from "./services/hr-ai.service";
import { KbRagService } from "./services/kb-rag.service";
import { ChatAssistantService } from "./services/chat-assistant.service";
import { ChatHistoryService } from "./services/chat-history.service";
import { AiUsageService } from "./services/ai-usage.service";
import { OrgFeaturesService } from "./services/org-features.service";
import { ProjectsAiService } from "./services/projects-ai.service";
import { HrCopilotTools } from "./hr-copilot-tools";
import { CalendarModule } from "../calendar/calendar.module";

@Module({
  imports: [CalendarModule],
  controllers: [CrmAiController, CrmCopilotController, HrAiController, KbRagController, ChatAssistantController, ProjectsAiController],
  providers: [
    LlmService,
    EmbeddingsService,
    CrmScoringService,
    CrmContentService,
    CrmBriefService,
    CrmTasksService,
    CrmCopilotService,
    HrAiService,
    KbRagService,
    ChatAssistantService,
    ChatHistoryService,
    AiUsageService,
    OrgFeaturesService,
    ProjectsAiService,
    HrCopilotTools,
  ],
  exports: [LlmService, EmbeddingsService, AiUsageService, OrgFeaturesService],
})
export class AiModule {}
