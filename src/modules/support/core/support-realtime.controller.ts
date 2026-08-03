import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { SupportRealtimeService } from "./support-realtime.service";

@RequireModule("support")
@Controller("support")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SupportRealtimeController {
  constructor(private readonly realtime: SupportRealtimeService) {}

  @Get("ably-token")
  @RequirePermission("support:tickets:view")
  getAblyToken(@CurrentUser() u: CurrentUserContext) {
    return this.realtime.createTokenRequest(u.userId, u.orgId);
  }
}
