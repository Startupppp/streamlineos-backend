import { Controller, Get, Post, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { InvAiExplainService } from "./inv-ai-explain.service";

@RequireModule("inventory")
@Controller("inventory/ai")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvAiExplainController {
  constructor(private readonly explainService: InvAiExplainService) {}

  @Post("insights/:insightId/explain")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  explainInsight(
    @Param("insightId", ParseIntPipe) insightId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.explainInsight(u.orgId, u.userId, insightId);
  }

  @Get("digest")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  getDigest(
    @Query("narrate") narrate: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.getDigest(u.orgId, u.userId, narrate === "true");
  }
}
