import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { vendorPaymentAllocateResponseSchema } from "./dto/ap-response.schemas";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { VendorPaymentsAllocationsService } from "./vendor-payments-allocations.service";
import {
  manualAllocationSchema,
  type ManualAllocationInput,
} from "./dto/finance-ap.schemas";
import { Validate } from "../../../common/validation/validate.decorator";

@RequireModule("accounting")
@Controller("accounting/vendor-payments")
@UseGuards(JwtAuthGuard)
export class VendorPaymentsAllocationsController {
  constructor(private readonly service: VendorPaymentsAllocationsService) {}

  @Post("allocations")
  @ResponseSchema(vendorPaymentAllocateResponseSchema)
  @Idempotent("accounting.vendor-payment.allocate")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payables:manage")
  @HttpCode(200)
  @Validate({ body: manualAllocationSchema })
  allocate(
    @Body() body: ManualAllocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.allocate(u.orgId, u.userId, body);
  }
}
