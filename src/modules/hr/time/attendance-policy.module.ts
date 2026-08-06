import { Module } from "@nestjs/common";
import { HrPoliciesModule } from "../policies/hr-policies.module";
import { AttendancePolicyService } from "./attendance-policy.service";

@Module({
  imports: [HrPoliciesModule],
  providers: [AttendancePolicyService],
  exports: [AttendancePolicyService],
})
export class AttendancePolicyModule {}
