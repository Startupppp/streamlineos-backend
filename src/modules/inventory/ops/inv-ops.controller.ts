import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { InvOpsService } from "./inv-ops.service";

/**
 * B2 — the operations board: the numbers a warehouse manager opens the morning
 * with, and the exceptions that need a decision today.
 *
 * All three surfaces are `inventory:stock:read`, not `inventory:reports:read`.
 * The distinction matters: reports carry cost and margin and are a finance
 * surface, while this is what is on the shelf and what is wrong with it —
 * exactly what a dark-store operator holds stock-read for. Stock value is the
 * one figure here that touches cost, and it is a scoped aggregate rather than a
 * per-SKU price, so it does not disclose what any one item was bought for.
 */
@RequireModule("inventory")
@Controller("inventory/ops")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvOpsController {
  constructor(private readonly svc: InvOpsService) {}

  @Get("summary")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  summary(@CurrentUser() u: CurrentUserContext) {
    return this.svc.summary(u.orgId, u.userId);
  }

  @Get("attention")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  attention(@CurrentUser() u: CurrentUserContext) {
    return this.svc.attention(u.orgId, u.userId);
  }

  @Get("zones")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  zones(@CurrentUser() u: CurrentUserContext) {
    return this.svc.zoneBoard(u.orgId, u.userId);
  }
}
