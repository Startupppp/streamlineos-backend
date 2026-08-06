import { Module } from "@nestjs/common";
import { HrTimeLedgerModule } from "../time/hr-time-ledger.module";
import { HrCoreModule } from "../core/hr-core.module";
import { HrBenefitsModule } from "../benefits/hr-benefits.module";
import { HrAutomationsModule } from "../automations/hr-automations.module";
import { PayrollInputsController } from "./payroll-inputs.controller";
import { PayrollInputsService } from "./payroll-inputs.service";
import { PayrollInputsBuildService } from "./payroll-inputs-build.service";

@Module({
  imports: [
    HrTimeLedgerModule,
    HrCoreModule,
    HrBenefitsModule,
    HrAutomationsModule,
  ],
  controllers: [PayrollInputsController],
  providers: [PayrollInputsService, PayrollInputsBuildService],
  exports: [PayrollInputsService],
})
export class HrPayrollInputsModule {}
