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
import { InvAiExplainService } from "./inv-ai-explain.service";
import { InvAiProposalService } from "./proposals/inv-ai-proposal.service";
import {
  invAiConfirmProposalSchema,
  invAiReorderProposalSchema,
  type InvAiConfirmProposalInput,
  type InvAiReorderProposalInput,
} from "./proposals/dto/inv-ai-proposal.schemas";

const digestQuerySchema = z.object({ narrate: z.enum(["true", "false"]).optional() });
const supplierDelayQuerySchema = z.object({ vendorId: z.coerce.number().int().positive().optional() });
type DigestQueryInput = z.infer<typeof digestQuerySchema>;
type SupplierDelayQueryInput = z.infer<typeof supplierDelayQuerySchema>;

@RequireModule("inventory")
@Controller("inventory/ai")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvAiExplainController {
  constructor(
    private readonly explainService: InvAiExplainService,
    private readonly proposals: InvAiProposalService,
  ) {}

  @Post("insights/:insightId/explain")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:read")
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
  @RequirePermission("inventory:ai:read")
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
  @RequirePermission("inventory:ai:read")
  narrateOpsBrief(@CurrentUser() u: CurrentUserContext) {
    return this.explainService.narrateOpsBrief(u.orgId, u.userId);
  }

  @Get("digest")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:read")
  getDigest(
    @Query(new ZodValidationPipe(digestQuerySchema)) query: DigestQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.getDigest(u.orgId, u.userId, query.narrate === "true");
  }

  /**
   * F4. The proposal is a **persisted C2 proposal**, narrated. The body names a
   * variant and at most a site; it cannot name a quantity or a supplier, because
   * `invAiReorderProposalSchema` has no field for either.
   */
  @Post("reorder-proposal")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:propose")
  getReorderProposal(
    @Body(new ZodValidationPipe(invAiReorderProposalSchema))
    body: InvAiReorderProposalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.proposals.propose(u, body);
  }

  /**
   * F1. This raises a draft purchase order, so it costs
   * `inventory:purchase-orders:create` **as well as** `inventory:ai:propose`.
   *
   * `@RequirePermission` takes one key, so the decorator can only state the
   * first half; the conjunction is asserted inside the service against the
   * stored proposal's own action (`inv-ai-confirm-authority.ts`). The decorator
   * is the cheap early denial, not the boundary.
   */
  @Post("reorder-proposal/confirm")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:propose")
  confirmReorderProposal(
    @Body(new ZodValidationPipe(invAiConfirmProposalSchema))
    body: InvAiConfirmProposalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.proposals.confirm(u, body);
  }

  @Get("supplier-delay")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:read")
  getSupplierDelayBriefing(
    @Query(new ZodValidationPipe(supplierDelayQuerySchema)) query: SupplierDelayQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.getSupplierDelayBriefing(u.orgId, u.userId, query.vendorId);
  }
}
