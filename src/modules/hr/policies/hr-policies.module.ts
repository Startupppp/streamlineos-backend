import { Module } from "@nestjs/common";
import { HrPoliciesController } from "./hr-policies.controller";
import { HrPoliciesService } from "./hr-policies.service";
import { HrPolicyEvaluationService } from "./hr-policy-evaluation.service";
import { HrPolicyConflictService } from "./hr-policy-conflict.service";
import { EmploymentFactsModule } from "../../directory/employment-facts.module";

@Module({
  imports: [EmploymentFactsModule],
  controllers: [HrPoliciesController],
  providers: [HrPoliciesService, HrPolicyEvaluationService, HrPolicyConflictService],
  exports: [HrPolicyEvaluationService, HrPolicyConflictService],
})
export class HrPoliciesModule {}
