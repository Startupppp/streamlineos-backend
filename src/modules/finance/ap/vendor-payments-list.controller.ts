import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { VendorPaymentsListService } from "./vendor-payments-list.service";
import { listVendorPaymentsQuerySchema, type ListVendorPaymentsQuery } from "./dto/finance-ap.schemas";
import { Validate } from "../../../common/validation/validate.decorator";

@RequireModule("accounting")
@Controller("accounting/vendor-payments")
@UseGuards(JwtAuthGuard)
export class VendorPaymentsListController {
  constructor(private readonly service: VendorPaymentsListService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payables:read")
  @Validate({ query: listVendorPaymentsQuerySchema })
  list(
    @Query() query: ListVendorPaymentsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, query);
  }
}
