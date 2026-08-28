import {
  BadRequestException,
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
import { InvAiExplainService } from "./inv-ai-explain.service";

const reorderProposalBodySchema = z.object({ variantId: z.number().int().positive(), warehouseId: z.number().int().positive().optional() });
const confirmProposalBodySchema = z.object({ proposalId: z.number().int().positive(), token: z.string().min(1) });
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
  explainInsight(
    @Param("insightId", ParseIntPipe) insightId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.explainInsight(u.orgId, u.userId, insightId);
  }

  /**
   * INV-101. Deterministic, unpaid, safe to call on page load -- which is why
   * it is a GET and why it does not carry the ai:invoke rate limit.
   */
  @Get("ops-brief")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  getOpsBrief(@CurrentUser() u: CurrentUserContext) {
    return this.explainService.getOpsBrief(u.orgId);
  }

  /**
   * The narrative. A POST because it spends credits: a human asked for it, and
   * no page render reaches this.
   */
  @Post("ops-brief/narrate")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:reports:read")
  narrateOpsBrief(@CurrentUser() u: CurrentUserContext) {
    return this.explainService.narrateOpsBrief(u.orgId, u.userId);
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
  getReorderProposal(
    @Body() rawBody: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const parsed = reorderProposalBodySchema.safeParse(rawBody);
    if (!parsed.success) throw new BadRequestException("Invalid request body");
    return this.explainService.getReorderProposal(u.orgId, u.userId, parsed.data.variantId, parsed.data.warehouseId);
  }

  @Post("reorder-proposal/confirm")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:propose")
  confirmReorderProposal(
    @Body() rawBody: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const parsed = confirmProposalBodySchema.safeParse(rawBody);
    if (!parsed.success) throw new BadRequestException("Invalid request body");
    return this.explainService.confirmReorderProposal(u.orgId, u.userId, parsed.data.proposalId, parsed.data.token);
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
