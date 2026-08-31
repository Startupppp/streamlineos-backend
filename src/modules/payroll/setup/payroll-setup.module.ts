import { Module } from "@nestjs/common";
import { PayrollTemplatesController } from "./templates.controller";
import { PayrollTemplatesService } from "./templates.service";
import { PayrollPoliciesController } from "./policies.controller";
import { PolicyQueryService } from "./policy-query.service";
import { PolicyMutationService } from "./policy-mutation.service";
import { PayrollComponentsController } from "./components.controller";
import { PayrollComponentsService } from "./components.service";

@Module({
  controllers: [
    PayrollTemplatesController,
    PayrollPoliciesController,
    PayrollComponentsController,
  ],
  providers: [
    PayrollTemplatesService,
    PolicyQueryService,
    PolicyMutationService,
    PayrollComponentsService,
  ],
  exports: [
    PayrollTemplatesService,
    PolicyQueryService,
    PolicyMutationService,
  ],
})
export class PayrollSetupModule {}
