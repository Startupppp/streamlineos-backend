import { Module } from "@nestjs/common";
import { HrCoreModule } from "../hr-core/hr-core.module";
import { HrWorkflowsModule } from "../hr-workflows/hr-workflows.module";
import { DevicesController } from "./devices.controller";
import { PayrollComplianceController } from "./payroll-compliance.controller";
import { CompPlanningController } from "./comp-planning.controller";
import { EquityController } from "./equity.controller";
import { WorkforceCostingController } from "./workforce-costing.controller";
import { DevicesService } from "./devices.service";
import { PayrollComplianceService } from "./payroll-compliance.service";
import { CompPlanningService } from "./comp-planning.service";
import { EquityService } from "./equity.service";
import { WorkforceCostingService } from "./workforce-costing.service";

@Module({
  imports: [HrCoreModule, HrWorkflowsModule],
  controllers: [
    DevicesController,
    PayrollComplianceController,
    CompPlanningController,
    EquityController,
    WorkforceCostingController,
  ],
  providers: [
    DevicesService,
    PayrollComplianceService,
    CompPlanningService,
    EquityService,
    WorkforceCostingService,
  ],
})
export class HrEnterpriseCompModule {}
