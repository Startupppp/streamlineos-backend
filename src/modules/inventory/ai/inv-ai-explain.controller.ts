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
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Validate } from "../../../common/validation/validate.decorator";
import { InvAiExplainService } from "./inv-ai-explain.service";
import {
  reorderProposalBodySchema,
  confirmProposalBodySchema,
  type ReorderProposalBodyInput,
  type ConfirmProposalBodyInput,
} from "./dto/ai-insights.schemas";

const insightIdParams = z.object({ insightId: z.coerce.number().int().positive() }).strict();

const digestQuerySchema = z.object({ narrate: z.enum(["true", "false"]).optional() });
const supplierDelayQuerySchema = z.object({ vendorId: z.coerce.number().int().positive().optional() });
type DigestQueryInput = z.infer<typeof digestQuerySchema>;
type SupplierDelayQueryInput = z.infer<typeof supplierDelayQuerySchema>;

@RequireModule("inventory")
@Controller("inventory/ai")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvAiExplainController {
  constructor(private readonly explainService: InvAiExplainService) {}

  @Post("insights/:insightId/explain")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:reports:read")
  @Validate({ params: insightIdParams })
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
    @Query(new ZodValidationPipe(digestQuerySchema)) query: DigestQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.getDigest(u.orgId, u.userId, query.narrate === "true");
  }

  @Post("reorder-proposal")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:propose")
  @Validate({ body: reorderProposalBodySchema })
  getReorderProposal(
    @Body() body: ReorderProposalBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.getReorderProposal(u.orgId, u.userId, body.variantId, body.warehouseId);
  }

  @Post("reorder-proposal/confirm")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:propose")
  @Validate({ body: confirmProposalBodySchema })
  confirmReorderProposal(
    @Body() body: ConfirmProposalBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.confirmReorderProposal(u.orgId, u.userId, body.proposalId, body.token);
  }

  @Get("supplier-delay")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:reports:read")
  getSupplierDelayBriefing(
    @Query(new ZodValidationPipe(supplierDelayQuerySchema)) query: SupplierDelayQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.getSupplierDelayBriefing(u.orgId, u.userId, query.vendorId);
  }
}
