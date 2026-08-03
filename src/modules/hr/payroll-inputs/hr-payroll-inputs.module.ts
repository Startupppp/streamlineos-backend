import { Module, forwardRef } from "@nestjs/common";
import { HrTimeModule } from "../time/hr-time.module";
import { HrCoreModule } from "../core/hr-core.module";
import { HrBenefitsModule } from "../benefits/hr-benefits.module";
import { HrAutomationsModule } from "../automations/hr-automations.module";
import { PayrollInputsController } from "./payroll-inputs.controller";
import { PayrollInputsService } from "./payroll-inputs.service";
import { PayrollInputsBuildService } from "./payroll-inputs-build.service";

@Module({
  imports: [
    forwardRef(() => HrTimeModule),
    HrCoreModule,
    HrBenefitsModule,
    HrAutomationsModule,
  ],
  controllers: [PayrollInputsController],
  providers: [PayrollInputsService, PayrollInputsBuildService],
  exports: [PayrollInputsService],
})
export class HrPayrollInputsModule {}
