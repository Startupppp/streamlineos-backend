import { Injectable } from "@nestjs/common";
import type { WorkflowGraphNode } from "./workflow-graph";
import type {
  NodeExecutionContext,
  NodeExecutionInput,
  NodeOutcome,
} from "./node-outcome";
import { executeNode } from "./workflow-node-executors";
import { ActionExecutor } from "./executors/action.executor";
import { WorkflowAiActionExecutor } from "./executors/ai-action.executor";
import { WorkflowIntegrationExecutor } from "./executors/integration.executor";
import { WorkflowLoopExecutor } from "./executors/loop.executor";
import { WorkflowScriptExecutor } from "./executors/script.executor";

/**
 * The seam between the runner and the node implementations: types needing DI or
 * IO are injected providers, the pure ones stay in `executeNode`. The runner
 * awaits this and never learns which kind it just called.
 */
@Injectable()
export class WorkflowNodeDispatcher {
  constructor(
    private readonly action: ActionExecutor,
    private readonly aiAction: WorkflowAiActionExecutor,
    private readonly integration: WorkflowIntegrationExecutor,
    private readonly loop: WorkflowLoopExecutor,
    private readonly script: WorkflowScriptExecutor,
  ) {}

  async execute(
    node: WorkflowGraphNode,
    input: NodeExecutionInput,
    now: Date,
    context: NodeExecutionContext,
  ): Promise<NodeOutcome> {
    switch (node.data.nodeType) {
      case "action":
        return this.action.execute(node, input, now, context);
      case "ai_action":
        return this.aiAction.execute(node, input, now, context);
      case "integration":
        return this.integration.execute(node, input, now, context);
      case "loop":
        return this.loop.execute(node, input, now, context);
      case "script":
        return this.script.execute(node, input, now, context);
      default:
        return executeNode(node, input, now);
    }
  }
}
