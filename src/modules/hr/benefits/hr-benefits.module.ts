import { Module } from "@nestjs/common";
import { HrBenefitsController } from "./hr-benefits.controller";
import { HrBenefitsClaimsController } from "./hr-benefits-claims.controller";
import { HrTravelVisitsController } from "./hr-travel-visits.controller";
import { HrBenefitsPlansService } from "./hr-benefits-plans.service";
import { HrBenefitsEnrollmentService } from "./hr-benefits-enrollment.service";
import { HrBenefitsClaimsService } from "./hr-benefits-claims.service";
import { HrTravelVisitsService } from "./hr-travel-visits.service";
import { HrPoliciesModule } from "../policies/hr-policies.module";

@Module({
  imports: [HrPoliciesModule],
  controllers: [HrBenefitsController, HrBenefitsClaimsController, HrTravelVisitsController],
  providers: [
    HrBenefitsPlansService,
    HrBenefitsEnrollmentService,
    HrBenefitsClaimsService,
    HrTravelVisitsService,
  ],
  exports: [HrBenefitsClaimsService],
})
export class HrBenefitsModule {}
