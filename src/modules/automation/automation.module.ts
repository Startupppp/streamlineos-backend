import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/core/billing.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AiModule } from "../ai/core/ai.module";
import { AiJobsModule } from "../ai/jobs/ai-jobs.module";
import { AiConfirmationModule } from "../ai/confirmation/ai-confirmation.module";
import { AutomationController } from "./automation.controller";
import { AutomationService } from "./automation.service";
import { AutomationEmailService } from "./automation-email.service";
import { AiNodeExecutorService } from "./ai-workflow-nodes/ai-node-executor.service";
import { WorkflowAiNodeHandler } from "./ai-workflow-nodes/ai-job-handlers/workflow-ai-node.handler";

@Module({
  imports: [BillingModule, NotificationsModule, AiModule, AiJobsModule, AiConfirmationModule],
  controllers: [AutomationController],
  providers: [
    AutomationService,
    AutomationEmailService,
    AiNodeExecutorService,
    WorkflowAiNodeHandler,
  ],
  exports: [AutomationService, AutomationEmailService],
})
export class AutomationModule {}
