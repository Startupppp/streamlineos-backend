import { Module } from "@nestjs/common";
import { HrTimeModule } from "../hr-time/hr-time.module";
import { HrCoreModule } from "../hr-core/hr-core.module";
import { PayrollInputsController } from "./payroll-inputs.controller";
import { PayrollInputsService } from "./payroll-inputs.service";
import { PayrollInputsBuildService } from "./payroll-inputs-build.service";

@Module({
  imports: [HrTimeModule, HrCoreModule],
  controllers: [PayrollInputsController],
  providers: [PayrollInputsService, PayrollInputsBuildService],
  exports: [PayrollInputsService],
})
export class HrPayrollInputsModule {}
