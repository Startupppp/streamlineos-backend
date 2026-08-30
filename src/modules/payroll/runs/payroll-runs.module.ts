import { Module } from "@nestjs/common";
import { AccessModule } from "../../access/access.module";
import { PayrollInsightsModule } from "../insights/payroll-insights.module";
import { PayrollEntitiesModule } from "../entities/payroll-entities.module";
import { DirectoryModule } from "../../directory/directory.module";
import { RunsController } from "./runs.controller";
import { RunsService } from "./runs.service";
import { GenerateService } from "./generate.service";
import { GeneratePipelineService } from "./generate-pipeline.service";
import { ProfilesController } from "./profiles.controller";
import { WorkerProfilesController } from "./worker-profiles.controller";
import { ProfilesService } from "./profiles.service";
import { PayeeEligibilityController } from "./payee-eligibility.controller";
import { PayeeEligibilityService } from "./payee-eligibility.service";
import { InputsController } from "./inputs.controller";
import { InputsService } from "./inputs.service";
import { ExceptionsController } from "./exceptions.controller";
import { ExceptionsService } from "./exceptions.service";
import { LoanAdjustmentsController } from "./loan-adjustments.controller";
import { LoanAdjustmentsService } from "./loan-adjustments.service";
import { CommandCenterController } from "./command-center.controller";
import { CommandCenterService } from "./command-center.service";
import { PayrollCommandReceiptsService } from "../command-receipts.service";
import { PayrollRunLockService } from "../run-lock.service";
import { PayrollRunCalculationGuardsService } from "./payroll-run-calculation-guards.service";
import { PayrollRunVarianceService } from "./payroll-run-variance.service";
import { SalaryProfilesRepository } from "./salary-profiles.repository";

@Module({
  imports: [AccessModule, PayrollInsightsModule, PayrollEntitiesModule, DirectoryModule],
  controllers: [
    RunsController,
    ProfilesController,
    WorkerProfilesController,
    PayeeEligibilityController,
    InputsController,
    ExceptionsController,
    LoanAdjustmentsController,
    CommandCenterController,
  ],
  providers: [
    RunsService,
    GenerateService,
    GeneratePipelineService,
    ProfilesService,
    PayeeEligibilityService,
    InputsService,
    ExceptionsService,
    LoanAdjustmentsService,
    CommandCenterService,
    PayrollCommandReceiptsService,
    PayrollRunLockService,
    PayrollRunCalculationGuardsService,
    PayrollRunVarianceService,
    SalaryProfilesRepository,
  ],
  exports: [GenerateService, PayrollCommandReceiptsService, PayrollRunLockService],
})
export class PayrollRunsModule {}
