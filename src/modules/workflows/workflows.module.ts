import { Module } from "@nestjs/common";
import { WorkflowsController } from "./workflows.controller";
import { WorkflowsService } from "./workflows.service";
import { WorkflowsCrudService } from "./workflows-crud.service";
import { WorkflowsExecutionService } from "./workflows-execution.service";
import { WorkflowRunnerService } from "./engine/workflow-runner.service";
import { WorkflowsCronController } from "./engine/workflows-cron.controller";
import { AccessModule } from "../access/access.module";

@Module({
  imports: [AccessModule],
  controllers: [WorkflowsController, WorkflowsCronController],
  providers: [
    WorkflowsCrudService,
    WorkflowsExecutionService,
    WorkflowsService,
    WorkflowRunnerService,
  ],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
