import { Module } from "@nestjs/common";
import { WorkflowsController } from "./workflows.controller";
import { WorkflowsService } from "./workflows.service";
import { WorkflowsCrudService } from "./workflows-crud.service";
import { WorkflowsExecutionService } from "./workflows-execution.service";
import { WorkflowRunnerService } from "./engine/workflow-runner.service";
import { WorkflowNodeDispatcher } from "./engine/node-dispatcher.service";
import { NODE_DISPATCH_PORT } from "./engine/node-outcome";
import { WorkflowsCronController } from "./engine/workflows-cron.controller";
import {
  ActionExecutor,
  AUTOMATION_ACTION_RUNNER,
} from "./engine/executors/action.executor";
import {
  AI_TEXT_GATEWAY,
  WorkflowAiActionExecutor,
} from "./engine/executors/ai-action.executor";
import {
  COMPOSIO_TOOL_CALLER,
  INTEGRATION_LOOKUP,
  WorkflowIntegrationExecutor,
} from "./engine/executors/integration.executor";
import { WorkflowLoopExecutor } from "./engine/executors/loop.executor";
import { WorkflowScriptExecutor } from "./engine/executors/script.executor";
import { AccessModule } from "../access/access.module";
import { AutomationModule } from "../automation/automation.module";
import { AutomationService } from "../automation/automation.service";
import { AiGatewayModule } from "../ai/core/gateway/ai-gateway.module";
import { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import { IntegrationsModule } from "../integrations/core/integrations.module";
import { IntegrationsService } from "../integrations/core/integrations.service";
import { ComposioGateway } from "../integrations/core/composio.gateway";

@Module({
  imports: [AccessModule, AutomationModule, AiGatewayModule, IntegrationsModule],
  controllers: [WorkflowsController, WorkflowsCronController],
  providers: [
    WorkflowsCrudService,
    WorkflowsExecutionService,
    WorkflowsService,
    WorkflowRunnerService,
    WorkflowNodeDispatcher,
    ActionExecutor,
    WorkflowAiActionExecutor,
    WorkflowIntegrationExecutor,
    WorkflowLoopExecutor,
    WorkflowScriptExecutor,
    { provide: NODE_DISPATCH_PORT, useExisting: WorkflowNodeDispatcher },
    { provide: AUTOMATION_ACTION_RUNNER, useExisting: AutomationService },
    { provide: AI_TEXT_GATEWAY, useExisting: AiGatewayService },
    { provide: INTEGRATION_LOOKUP, useExisting: IntegrationsService },
    { provide: COMPOSIO_TOOL_CALLER, useExisting: ComposioGateway },
  ],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
