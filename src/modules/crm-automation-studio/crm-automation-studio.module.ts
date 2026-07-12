import { Module, forwardRef } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { AutomationModule } from "../automation/automation.module";
import { CrmAutomationBusService } from "./crm-automation-bus.service";
import { CrmAutomationRunnerService } from "./crm-automation-runner.service";
import { CrmSequencesRunnerService } from "./crm-sequences-runner.service";
import { CrmSequencesService } from "./crm-sequences.service";
import { CrmAutomationStudioController } from "./crm-automation-studio.controller";

@Module({
  imports: [NotificationsModule, AutomationModule],
  controllers: [CrmAutomationStudioController],
  providers: [
    CrmAutomationBusService,
    CrmAutomationRunnerService,
    CrmSequencesRunnerService,
    CrmSequencesService,
    {
      provide: "CrmAutomationBusService",
      useExisting: CrmAutomationBusService,
    },
    {
      provide: "CrmAutomationRunnerService",
      useExisting: CrmAutomationRunnerService,
    },
  ],
  exports: [CrmAutomationBusService, CrmAutomationRunnerService, CrmSequencesRunnerService],
})
export class CrmAutomationStudioModule {}
