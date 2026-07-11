import { Module } from "@nestjs/common";
import { HrTimeModule } from "../hr-time/hr-time.module";
import { HrCoreModule } from "../hr-core/hr-core.module";
import { HrBenefitsModule } from "../hr-benefits/hr-benefits.module";
import { HrAutomationsModule } from "../hr-automations/hr-automations.module";
import { PayrollInputsController } from "./payroll-inputs.controller";
import { PayrollInputsService } from "./payroll-inputs.service";
import { PayrollInputsBuildService } from "./payroll-inputs-build.service";

@Module({
  imports: [HrTimeModule, HrCoreModule, HrBenefitsModule, HrAutomationsModule],
  controllers: [PayrollInputsController],
  providers: [PayrollInputsService, PayrollInputsBuildService],
  exports: [PayrollInputsService],
})
export class HrPayrollInputsModule {}
