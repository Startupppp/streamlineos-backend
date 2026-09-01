import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { ApiResponse } from "@nestjs/swagger";
import { AuthorizedInService } from "../../common/auth/authorized-in-service.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { operatorOrgParamsSchema } from "./dto/platform.schemas";
import { OperatorSessionGuard } from "./operator-session.guard";
import { PlatformOperatorCustomerService } from "./platform-operator-customer.service";
import { RequireOperatorGrant } from "./require-operator-grant.decorator";

@Controller("platform/operator/organizations/:orgId")
@UseGuards(OperatorSessionGuard)
@AuthorizedInService(
  "OperatorSessionGuard validates and audits a target-organization grant before the tenant transaction opens",
)
export class PlatformOperatorCustomerController {
  constructor(private readonly customers: PlatformOperatorCustomerService) {}

  @Get()
  @ApiResponse({ status: 200, description: "Organization identity and recent members" })
  @RequireOperatorGrant("read_customer_data")
  @Validate({ params: operatorOrgParamsSchema })
  getCustomer(@Param("orgId") orgId: string) {
    return this.customers.getCustomer(orgId);
  }

  @Get("billing")
  @ApiResponse({ status: 200, description: "Subscription and recent payment history" })
  @RequireOperatorGrant("read_payments")
  @Validate({ params: operatorOrgParamsSchema })
  getBilling(@Param("orgId") orgId: string) {
    return this.customers.getBilling(orgId);
  }
}
