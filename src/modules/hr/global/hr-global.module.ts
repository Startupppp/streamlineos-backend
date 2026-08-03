import { Module } from "@nestjs/common";
import { HrCoreModule } from "../core/hr-core.module";
import { HrTemplatesModule } from "../templates/hr-templates.module";
import { HrAutomationsModule } from "../automations/hr-automations.module";
import { WorkAuthorizationsController } from "./work-authorizations.controller";
import { ComplianceController } from "./compliance.controller";
import { ContractsController } from "./contracts.controller";
import { WorkAuthorizationsService } from "./work-authorizations.service";
import { ComplianceRequirementsService } from "./compliance-requirements.service";
import { ContractsService } from "./contracts.service";

@Module({
  imports: [HrCoreModule, HrTemplatesModule, HrAutomationsModule],
  controllers: [
    WorkAuthorizationsController,
    ComplianceController,
    ContractsController,
  ],
  providers: [
    WorkAuthorizationsService,
    ComplianceRequirementsService,
    ContractsService,
  ],
  exports: [ComplianceRequirementsService, WorkAuthorizationsService, ContractsService],
})
export class HrGlobalModule {}
