import { Module } from "@nestjs/common";
import { WorkflowsController } from "./workflows.controller";
import { WorkflowsService } from "./workflows.service";
import { WorkflowsCrudService } from "./workflows-crud.service";
import { WorkflowsExecutionService } from "./workflows-execution.service";
import { AccessModule } from "../access/access.module";

@Module({
  imports: [AccessModule],
  controllers: [WorkflowsController],
  providers: [WorkflowsCrudService, WorkflowsExecutionService, WorkflowsService],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
