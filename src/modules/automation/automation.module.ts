import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/core/billing.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AiModule } from "../ai/core/ai.module";
import { AiJobsModule } from "../ai/jobs/ai-jobs.module";
import { AiConfirmationModule } from "../ai/confirmation/ai-confirmation.module";
import { AutomationController } from "./automation.controller";
import { AutomationActionExecutor } from "./automation-action-executor.service";
import { AutomationService } from "./automation.service";
import { AutomationEmailService } from "./automation-email.service";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { AiNodeExecutorService } from "./ai-workflow-nodes/ai-node-executor.service";
import { WorkflowAiNodeHandler } from "./ai-workflow-nodes/ai-job-handlers/workflow-ai-node.handler";

@Module({
  imports: [
    BillingModule,
    NotificationsModule,
    AiModule,
    AiJobsModule,
    AiConfirmationModule,
    WebhooksModule,
  ],
  controllers: [AutomationController],
  providers: [
    AutomationService,
    AutomationActionExecutor,
    AutomationEmailService,
    AiNodeExecutorService,
    WorkflowAiNodeHandler,
  ],
  exports: [
    AutomationService,
    AutomationEmailService,
    AutomationActionExecutor,
  ],
})
export class AutomationModule {}
