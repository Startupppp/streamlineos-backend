import { Module } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { EmployeesController } from "./employees.controller";
import { OrgStructureController } from "./org-structure.controller";
import { TeamEventsController } from "./team-events.controller";
import { AssetsController } from "./assets.controller";
import { AssetInventoryController } from "./asset-inventory.controller";
import { BackgroundVerificationController } from "./background-verification.controller";
import { AccessRequestsController } from "./access-requests.controller";
import { EmployeesService } from "./employees.service";
import { EmployeeMutationsService } from "./employee-mutations.service";
import { OrgStructureService } from "./org-structure.service";
import { CelebrationsService } from "./celebrations.service";
import { EmployeeSkillsService } from "./employee-skills.service";
import { TeamEventsService } from "./team-events.service";
import { AssetsService } from "./assets.service";
import { AssetInventoryService } from "./asset-inventory.service";
import { AssetsRecoveryService } from "./assets-recovery.service";
import { BackgroundVerificationService } from "./background-verification.service";
import { AccessRequestsService } from "./access-requests.service";

@Module({
  imports: [AutomationModule, WebhooksModule],
  controllers: [
    EmployeesController,
    OrgStructureController,
    TeamEventsController,
    AssetsController,
    AssetInventoryController,
    BackgroundVerificationController,
    AccessRequestsController,
  ],
  providers: [
    EmployeesService,
    EmployeeMutationsService,
    OrgStructureService,
    CelebrationsService,
    EmployeeSkillsService,
    TeamEventsService,
    AssetsService,
    AssetInventoryService,
    AssetsRecoveryService,
    BackgroundVerificationService,
    AccessRequestsService,
  ],
  exports: [AssetsRecoveryService],
})
export class HrDirectoryModule {}
