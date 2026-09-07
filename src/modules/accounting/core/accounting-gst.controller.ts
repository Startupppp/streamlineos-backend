import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccountingGstService } from "./accounting-gst.service";
import {
  gstr1QuerySchema,
  gstr3BQuerySchema,
  type Gstr1Query,
  type Gstr3BQuery,
} from "./dto/accounting.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { gstr1ResponseSchema, gstr3bResponseSchema } from "./dto/accounting-gst-response.schemas";

@RequireModule("accounting")
@Controller("accounting/reports")
@UseGuards(JwtAuthGuard)
export class AccountingGstController {
  constructor(private readonly gst: AccountingGstService) {}

  @Get("gstr-1")
  @ResponseSchema(gstr1ResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: gstr1QuerySchema })
  gstr1(
    @Query() query: Gstr1Query,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.gst.gstr1(u.orgId, query);
  }

  @Get("gstr-3b")
  @ResponseSchema(gstr3bResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: gstr3BQuerySchema })
  gstr3b(
    @Query() query: Gstr3BQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.gst.gstr3b(u.orgId, query);
  }
}
