import { Module } from "@nestjs/common";
import { AutomationModule } from "../../automation/automation.module";
import { BonusesController } from "./bonuses.controller";
import { LoansController } from "./loans.controller";
import { IncentivesController } from "./incentives.controller";
import { HrPayrollReimbursementsController } from "./reimbursements.controller";
import { HrPayrollFnfController } from "./fnf.controller";
import { SalaryStructureTemplatesController } from "./salary-structure-templates.controller";
import { BonusesService } from "./bonuses.service";
import { LoansService } from "./loans.service";
import { IncentivesService } from "./incentives.service";
import { ReimbursementsService } from "./reimbursements.service";
import { FnfService } from "./fnf.service";
import { SalaryStructureTemplatesService } from "./salary-structure-templates.service";
import { TaxService } from "./tax.service";

@Module({
  imports: [AutomationModule],
  controllers: [
    BonusesController,
    LoansController,
    IncentivesController,
    HrPayrollReimbursementsController,
    HrPayrollFnfController,
    SalaryStructureTemplatesController,
  ],
  providers: [
    BonusesService,
    LoansService,
    IncentivesService,
    ReimbursementsService,
    FnfService,
    SalaryStructureTemplatesService,
    TaxService,
  ],
  exports: [FnfService, TaxService, ReimbursementsService, LoansService],
})
export class HrPayrollModule {}
