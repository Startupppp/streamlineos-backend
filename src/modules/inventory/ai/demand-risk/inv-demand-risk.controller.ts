import { Body, Controller, Post, UseGuards, UseInterceptors } from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { AiRequestAbortInterceptor } from "../../../ai/core/streaming";
import { NoTenantTransaction } from "../../../../common/tenant";
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
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { demandRiskResponseSchema } from "./dto/inv-demand-risk-response.schemas";

/**
 * F3 — the demand-risk narrative's one route.
 *
 * A POST because it may spend credits: a human asked for it, and no page render
 * reaches it. Gated on `inventory:ai:read` and nothing else, because it reads
 * and only reads — it narrates a forecast the C-wave engine already stored and
 * has no path to commissioning one, let alone to a stock movement.
 *
 * `@NoTenantTransaction()` because `explain` ends in an `AiGatewayService` round
 * trip, and under the ambient request transaction that call was awaited with a
 * pooled connection checked out and idle in transaction for the length of
 * somebody else's outage — against the 60s `idle_in_transaction_session_timeout`
 * `withTenant` sets. Every read on this path (the warehouse-scope check, the
 * stored forecast version and the live demand baseline) now happens inside one
 * short `runInTenantTransaction` in `InvDemandRiskService.explain` that commits
 * before the gateway call; nothing after it touches the database.
 * `@UseInterceptors(AiRequestAbortInterceptor)` restores the cancellation signal
 * the decorator removes, so the released connection is not bought with an
 * uncancellable, still-billed provider call (PRD-C091).
 */
@RequireModule("inventory")
@Controller("inventory/ai/demand-risk")
@UseGuards(JwtAuthGuard, ModuleGuard)
@UseInterceptors(AiRequestAbortInterceptor)
export class InvDemandRiskController {
  constructor(private readonly demandRisk: InvDemandRiskService) {}

  @Post()
  @ResponseSchema(demandRiskResponseSchema)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:read")
  @NoTenantTransaction()
  explain(
    @Body(new ZodValidationPipe(demandRiskSchema)) body: DemandRiskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.demandRisk.explain(u, body);
  }
}
