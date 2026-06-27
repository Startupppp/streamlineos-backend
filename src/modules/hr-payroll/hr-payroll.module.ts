import { Module } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { PayrollsController } from "./payrolls.controller";
import { PayrollReportsController } from "./payroll-reports.controller";
import { BonusesController } from "./bonuses.controller";
import { LoansController } from "./loans.controller";
import { IncentivesController } from "./incentives.controller";
import { ReimbursementsController } from "./reimbursements.controller";
import { FnfController } from "./fnf.controller";
import { PayrollsService } from "./payrolls.service";
import { PayrollStatusService } from "./payrolls-status.service";
import { CompensationService } from "./compensation.service";
import { BonusesService } from "./bonuses.service";
import { LoansService } from "./loans.service";
import { IncentivesService } from "./incentives.service";
import { ReimbursementsService } from "./reimbursements.service";
import { FnfService } from "./fnf.service";

@Module({
  imports: [AutomationModule],
  controllers: [
    PayrollsController,
    PayrollReportsController,
    BonusesController,
    LoansController,
    IncentivesController,
    ReimbursementsController,
    FnfController,
  ],
  providers: [
    PayrollsService,
    PayrollStatusService,
    CompensationService,
    BonusesService,
    LoansService,
    IncentivesService,
    ReimbursementsService,
    FnfService,
  ],
})
export class HrPayrollModule {}
