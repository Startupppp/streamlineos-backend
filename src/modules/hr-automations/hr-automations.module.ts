import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { HrAutomationsController } from "./hr-automations.controller";
import { HrAutomationEngineService } from "./hr-automation-engine.service";
import { HrAutomationActionsService } from "./hr-automation-actions.service";
import { AutomationEmailService } from "../automation/automation-email.service";
import { HR_WORKFLOW_STARTER } from "./hr-workflow-starter.port";
import { HrWorkflowsModule } from "../hr-workflows/hr-workflows.module";
import { HrWorkflowStarterAdapter } from "../hr-workflows/hr-workflow-starter.adapter";

@Module({
  imports: [NotificationsModule, HrWorkflowsModule],
  controllers: [HrAutomationsController],
  providers: [
    HrAutomationEngineService,
    HrAutomationActionsService,
    AutomationEmailService,
    {
      provide: HR_WORKFLOW_STARTER,
      useExisting: HrWorkflowStarterAdapter,
    },
  ],
  exports: [HrAutomationEngineService],
})
export class HrAutomationsModule {}
