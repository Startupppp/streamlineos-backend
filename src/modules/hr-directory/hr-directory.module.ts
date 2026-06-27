import { Module } from "@nestjs/common";
import { EmployeesController } from "./employees.controller";
import { OrgStructureController } from "./org-structure.controller";
import { TeamEventsController } from "./team-events.controller";
import { AssetsController } from "./assets.controller";
import { AssetInventoryController } from "./asset-inventory.controller";
import { BackgroundVerificationController } from "./background-verification.controller";
import { EmployeesService } from "./employees.service";
import { OrgStructureService } from "./org-structure.service";
import { CelebrationsService } from "./celebrations.service";
import { EmployeeSkillsService } from "./employee-skills.service";
import { TeamEventsService } from "./team-events.service";
import { AssetsService } from "./assets.service";
import { AssetInventoryService } from "./asset-inventory.service";
import { BackgroundVerificationService } from "./background-verification.service";

@Module({
  controllers: [
    EmployeesController,
    OrgStructureController,
    TeamEventsController,
    AssetsController,
    AssetInventoryController,
    BackgroundVerificationController,
  ],
  providers: [
    EmployeesService,
    OrgStructureService,
    CelebrationsService,
    EmployeeSkillsService,
    TeamEventsService,
    AssetsService,
    AssetInventoryService,
    BackgroundVerificationService,
  ],
})
export class HrDirectoryModule {}
