import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ExecutiveBriefService } from "./executive-brief.service";

@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller("ai/executive-brief")
export class ExecutiveBriefController {
  constructor(private readonly service: ExecutiveBriefService) {}

  @RequirePermission("ai:executive-brief:view")
  @Get()
  async getLatest(@CurrentUser() u: CurrentUserContext) {
    return this.service.getLatest(u.orgId);
  }

  @RequirePermission("ai:executive-brief:generate")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @Post("generate")
  async generate(@CurrentUser() u: CurrentUserContext) {
    return this.service.generate(u.orgId, u.userId);
  }
}
