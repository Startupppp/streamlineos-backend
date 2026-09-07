import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { InvBarcodeService } from "./inv-barcode.service";
import { barcodeLookupSchema, type BarcodeLookupInput } from "./dto/inv-barcode.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { barcodeLookupResponseSchema } from "./dto/barcode-response.schemas";

@RequireModule("inventory")
@Controller("inventory/barcode")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvBarcodeController {
  constructor(private readonly barcodeService: InvBarcodeService) {}

  @Get("lookup")
  @ResponseSchema(barcodeLookupResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ query: barcodeLookupSchema })
  lookup(
    @Query() query: BarcodeLookupInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.barcodeService.lookup(u.orgId, query.code);
  }
}
