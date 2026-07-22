import { Module } from "@nestjs/common";
import { AccessModule } from "../../access/access.module";
import { PayrollInsightsModule } from "../insights/payroll-insights.module";
import { RunsController } from "./runs.controller";
import { RunsService } from "./runs.service";
import { GenerateService } from "./generate.service";
import { GeneratePipelineService } from "./generate-pipeline.service";
import { ProfilesController } from "./profiles.controller";
import { ProfilesService } from "./profiles.service";
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

@Module({
  imports: [AccessModule, PayrollInsightsModule],
  controllers: [
    RunsController,
    ProfilesController,
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
    InputsService,
    ExceptionsService,
    LoanAdjustmentsService,
    CommandCenterService,
    PayrollCommandReceiptsService,
    PayrollRunLockService,
  ],
  exports: [GenerateService, PayrollCommandReceiptsService, PayrollRunLockService],
})
export class PayrollRunsModule {}
