import { Module } from "@nestjs/common";
import { BillingModule } from "../../billing/core/billing.module";
import { MembershipAdmissionService } from "./membership-admission.service";

@Module({
  imports: [BillingModule],
  providers: [MembershipAdmissionService],
  exports: [MembershipAdmissionService],
})
export class MembershipAdmissionModule {}
