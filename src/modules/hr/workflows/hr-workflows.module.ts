import { Module } from "@nestjs/common";
import { HrWorkflowDefinitionsController } from "./hr-workflow-definitions.controller";
import { HrWorkflowInstancesController } from "./hr-workflow-instances.controller";
import { HrWorkflowDelegationsController } from "./hr-workflow-delegations.controller";
import { HrWorkflowDefinitionsService } from "./hr-workflow-definitions.service";
import { HrWorkflowInstancesService } from "./hr-workflow-instances.service";
import { HrWorkflowDelegationsService } from "./hr-workflow-delegations.service";
import { HrWorkflowEngineService } from "./hr-workflow-engine.service";
import { HrWorkflowStarterAdapter } from "./hr-workflow-starter.adapter";
import { DirectoryModule } from "../../directory/directory.module";

@Module({
  imports: [DirectoryModule],
  controllers: [
    HrWorkflowDefinitionsController,
    HrWorkflowInstancesController,
    HrWorkflowDelegationsController,
  ],
  providers: [
    HrWorkflowEngineService,
    HrWorkflowDefinitionsService,
    HrWorkflowInstancesService,
    HrWorkflowDelegationsService,
    HrWorkflowStarterAdapter,
  ],
  exports: [HrWorkflowEngineService, HrWorkflowStarterAdapter],
})
export class HrWorkflowsModule {}
