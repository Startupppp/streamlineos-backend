import { Module } from "@nestjs/common";
import { PayrollTemplatesController } from "./templates.controller";
import { PayrollTemplatesService } from "./templates.service";
import { PayrollPoliciesController } from "./policies.controller";
import { PayrollPoliciesService } from "./policies.service";
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
    PayrollPoliciesService,
    PayrollComponentsService,
  ],
  exports: [
    PayrollTemplatesService,
    PayrollPoliciesService,
  ],
})
export class PayrollSetupModule {}
