import { Module } from "@nestjs/common";
import { HrPoliciesController } from "./hr-policies.controller";
import { HrPoliciesService } from "./hr-policies.service";
import { HrPolicyEvaluationService } from "./hr-policy-evaluation.service";

@Module({
  controllers: [HrPoliciesController],
  providers: [HrPoliciesService, HrPolicyEvaluationService],
  exports: [HrPolicyEvaluationService],
})
export class HrPoliciesModule {}
