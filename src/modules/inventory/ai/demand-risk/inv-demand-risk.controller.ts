import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ModuleGuard } from "../../../../common/rbac/module.guard";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { ZodValidationPipe } from "../../../../common/pipes/zod-validation.pipe";
import { InvDemandRiskService } from "./inv-demand-risk.service";
import { demandRiskSchema, type DemandRiskInput } from "./dto/inv-demand-risk.schemas";

/**
 * F3 — the demand-risk narrative's one route.
 *
 * A POST because it may spend credits: a human asked for it, and no page render
 * reaches it. Gated on `inventory:ai:read` and nothing else, because it reads
 * and only reads — it narrates a forecast the C-wave engine already stored and
 * has no path to commissioning one, let alone to a stock movement.
 */
@RequireModule("inventory")
@Controller("inventory/ai/demand-risk")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvDemandRiskController {
  constructor(private readonly demandRisk: InvDemandRiskService) {}

  @Post()
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:read")
  explain(
    @Body(new ZodValidationPipe(demandRiskSchema)) body: DemandRiskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.demandRisk.explain(u, body);
  }
}
