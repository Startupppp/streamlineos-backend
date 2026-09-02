import { Global, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { WorkflowRegistry } from "./workflow-registry";
import { WorkflowRunnerService } from "./workflow-runner.service";
import { WorkflowOutboxRelayService } from "./workflow-outbox-relay.service";
import { WorkflowInspectorService } from "./workflow-inspector.service";
import { selfcheckWorkflow } from "./workflow-selfcheck";

/**
 * The durable workflow runtime.
 *
 * Global because a workflow is registered by the module that owns it, and
 * started from wherever the work arises — a request handler, the relay, a sweep.
 *
 * Nothing here schedules itself. The cron module drives `relay()` and `drain()`,
 * so there is one place that decides how often background work runs rather than
 * a timer hidden in a service.
 */
@Global()
@Module({
  providers: [
    WorkflowRegistry,
    WorkflowRunnerService,
    WorkflowOutboxRelayService,
    WorkflowInspectorService,
  ],
  exports: [
    WorkflowRegistry,
    WorkflowRunnerService,
    WorkflowOutboxRelayService,
  ],
})
export class WorkflowModule implements OnModuleInit {
  private readonly logger = new Logger("Workflow");

  constructor(private readonly registry: WorkflowRegistry) {}

  onModuleInit(): void {
    // Outside production only: a workflow that exists to be run by an operator
    // has no business being startable against real tenants.
    if (process.env.NODE_ENV !== "production") this.registry.register(selfcheckWorkflow);

    this.logger.log(
      this.registry.names.length > 0
        ? `Workflows registered — ${this.registry.names.join(", ")}`
        : "No workflows registered",
    );
  }
}
