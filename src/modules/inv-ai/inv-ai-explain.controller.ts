import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { InvAiExplainService } from "./inv-ai-explain.service";

@RequireModule("inventory")
@Controller("inventory/ai")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvAiExplainController {
  constructor(private readonly explainService: InvAiExplainService) {}

  @Post("insights/:insightId/explain")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:reports:read")
  explainInsight(
    @Param("insightId", ParseIntPipe) insightId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.explainInsight(u.orgId, u.userId, insightId);
  }

  @Get("digest")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:reports:read")
  getDigest(
    @Query("narrate") narrate: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.getDigest(u.orgId, u.userId, narrate === "true");
  }

  @Post("reorder-proposal")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:propose")
  getReorderProposal(
    @Body() body: { variantId: number; warehouseId?: number },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.getReorderProposal(u.orgId, u.userId, body.variantId, body.warehouseId);
  }

  @Post("reorder-proposal/confirm")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:propose")
  confirmReorderProposal(
    @Body() body: { proposalId: number; token: string },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.confirmReorderProposal(u.orgId, u.userId, body.proposalId, body.token);
  }

  @Get("supplier-delay")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:reports:read")
  getSupplierDelayBriefing(
    @Query("vendorId") vendorIdStr: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const vendorId = vendorIdStr != null ? parseInt(vendorIdStr, 10) : undefined;
    return this.explainService.getSupplierDelayBriefing(u.orgId, u.userId, vendorId);
  }
}
