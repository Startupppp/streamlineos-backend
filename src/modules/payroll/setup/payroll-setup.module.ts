import { Module } from "@nestjs/common";
import { PayrollTemplatesController } from "./templates.controller";
import { PayrollTemplatesService } from "./templates.service";
import { PayrollPoliciesController } from "./policies.controller";
import { PolicyQueryService } from "./policy-query.service";
import { PolicyMutationService } from "./policy-mutation.service";
import { PayrollComponentsController } from "./components.controller";
import { PayrollComponentsService } from "./components.service";
import { SalaryPreviewController } from "./salary-preview.controller";
import { SalaryPreviewService } from "./salary-preview.service";
import { RunDataLoaderService } from "../runs/run-data-loader.service";

@Module({
  controllers: [
    PayrollTemplatesController,
    PayrollPoliciesController,
    PayrollComponentsController,
    SalaryPreviewController,
  ],
  providers: [
    PayrollTemplatesService,
    PolicyQueryService,
    PolicyMutationService,
    PayrollComponentsService,
    SalaryPreviewService,
    RunDataLoaderService,
  ],
  exports: [
    PayrollTemplatesService,
    PolicyQueryService,
    PolicyMutationService,
  ],
})
export class PayrollSetupModule {}
