import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { InvBarcodeService } from "./inv-barcode.service";
import {
  barcodeLookupSchema,
  barcodeScanSchema,
  type BarcodeLookupInput,
  type BarcodeScanInput,
} from "./dto/inv-barcode.schemas";
import { Validate } from "../../../common/validation/validate.decorator";

@RequireModule("inventory")
@Controller("inventory/barcode")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvBarcodeController {
  constructor(private readonly barcodeService: InvBarcodeService) {}

  @Get("lookup")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ query: barcodeLookupSchema })
  lookup(
    @Query() query: BarcodeLookupInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.barcodeService.lookup(u.orgId, u.userId, query.code);
  }

  /**
   * INV-203. A POST because the payload carries control characters that have no
   * business in a query string -- FNC1 is structure the parser needs, and a URL
   * layer that helpfully strips or re-encodes it turns a multi-element label
   * into one long lot number.
   *
   * Read-only: it resolves and reports, and posts no stock.
   */
  @Post("scan")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ body: barcodeScanSchema })
  scan(
    @Body() body: BarcodeScanInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.barcodeService.scan(u.orgId, u.userId, body.payload);
  }

  /**
   * INV-203. Records the scan as a fact and emits `inventory.scan.captured`.
   * Idempotent on the caller's key, because a scanner on a failing network
   * retries and three facts for one physical event corrupt a throughput count
   * as surely as none would.
   */
  @Post("scan/capture")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ body: barcodeScanSchema })
  captureScan(
    @Body() body: BarcodeScanInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.barcodeService.captureScan(u.orgId, u.userId, idempotencyKey, body.payload);
  }
}
