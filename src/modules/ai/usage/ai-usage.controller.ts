import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AiUsageService } from "./ai-usage.service";

@Controller("ai/usage")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AiUsageController {
  constructor(private readonly usage: AiUsageService) {}

  @Get()
  @RequirePermission("ai:usage:view")
  getUsage(@CurrentUser() u: CurrentUserContext) {
    return this.usage.getOrgUsage(u);
  }
}
