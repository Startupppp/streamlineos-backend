import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ArPaymentsService } from "./ar-payments.service";
import { listArPaymentsSchema, type ListArPaymentsQuery } from "./dto/finance-ar.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { arPaymentListResponseSchema } from "./dto/ar-response.schemas";

@RequireModule("accounting")
@Controller("accounting/ar-payments")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ArPaymentsController {
  constructor(private readonly svc: ArPaymentsService) {}

  @Get()
  @ResponseSchema(arPaymentListResponseSchema)
  @RequirePermission("accounting:receivables:read")
  @Validate({ query: listArPaymentsSchema })
  list(
    @Query() query: ListArPaymentsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, query);
  }
}
