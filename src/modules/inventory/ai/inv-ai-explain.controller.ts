import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { AiRequestAbortInterceptor } from "../../ai/core/streaming";
import { NoTenantTransaction } from "../../../common/tenant";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { InvAiExplainService } from "./inv-ai-explain.service";
import { InvAiProposalService } from "./proposals/inv-ai-proposal.service";
import {
  invAiConfirmProposalSchema as confirmProposalBodySchema,
  invAiReorderProposalSchema as reorderProposalBodySchema,
} from "./proposals/dto/inv-ai-proposal.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import {
  explainInsightResponseSchema,
  digestResponseSchema,
  reorderProposalResponseSchema,
  confirmReorderProposalResponseSchema,
  supplierDelayBriefingResponseSchema,
  opsBriefResponseSchema,
  narrateOpsBriefResponseSchema,
} from "./dto/ai-response.schemas";

const insightIdParams = z.object({ insightId: z.coerce.number().int().positive() }).strict();

const digestQuerySchema = z.object({ narrate: z.enum(["true", "false"]).optional() });
const supplierDelayQuerySchema = z.object({ vendorId: z.coerce.number().int().positive().optional() });
type DigestQueryInput = z.infer<typeof digestQuerySchema>;
type SupplierDelayQueryInput = z.infer<typeof supplierDelayQuerySchema>;

/**
 * `@UseInterceptors(AiRequestAbortInterceptor)` sits on the class rather than on
 * `narrateOpsBrief` alone, and that is deliberate on both counts.
 *
 * On `narrateOpsBrief` it is the required half of the `@NoTenantTransaction()`
 * opt-out: the decorator removes the tenant context's disconnect signal, which
 * was `getAmbientAiAbortSignal`'s only source, so without the interceptor the
 * released connection would be bought with an uncancellable, still-billed
 * provider call (PRD-C091).
 *
 * On the four handlers that KEEP the request transaction it is strictly an
 * improvement and never a behaviour change: `getAmbientAiAbortSignal` already
 * falls back to the tenant signal, the interceptor only arms an `AbortSignal`
 * inside an AsyncLocalStorage scope, and it writes nothing to the response. It
 * also picks up the caller's `Idempotency-Key` for the gateway's reservation
 * key, which those four previously had no way to supply.
 */
@RequireModule("inventory")
@Controller("inventory/ai")
@UseGuards(JwtAuthGuard, ModuleGuard)
@UseInterceptors(AiRequestAbortInterceptor)
export class InvAiExplainController {
  constructor(
    private readonly explainService: InvAiExplainService,
    private readonly proposals: InvAiProposalService,
  ) {}

  @Post("insights/:insightId/explain")
  @BodylessAction()
  @ResponseSchema(explainInsightResponseSchema)
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

  /**
   * INV-101. Deterministic, unpaid, safe to call on page load -- which is why
   * it is a GET and why it does not carry the ai:invoke rate limit.
   */
  @Get("ops-brief")
  @ResponseSchema(opsBriefResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:ai:read")
  getOpsBrief(@CurrentUser() u: CurrentUserContext) {
    return this.explainService.getOpsBrief(u.orgId);
  }

  /**
   * The narrative. A POST because it spends credits: a human asked for it, and
   * no page render reaches this.
   *
   * `@NoTenantTransaction()` because it ends in `AiGatewayService.invokeStructured`
   * and under the ambient request transaction that round trip was awaited with a
   * pooled connection idle in transaction, against the 60s
   * `idle_in_transaction_session_timeout` `withTenant` sets. The one read on the
   * path — `InvAiService.getOpsBrief`, the deterministic signal aggregate — now
   * runs in a short `runInTenantTransaction` that commits before the call, and
   * nothing after it touches the database.
   */
  @Post("ops-brief/narrate")
  @BodylessAction()
  @ResponseSchema(narrateOpsBriefResponseSchema)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:read")
  @NoTenantTransaction()
  narrateOpsBrief(@CurrentUser() u: CurrentUserContext) {
    return this.explainService.narrateOpsBrief(u.orgId, u.userId);
  }

  @Get("digest")
  @ResponseSchema(digestResponseSchema)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:reports:read")
  @Validate({ query: digestQuerySchema })
  getDigest(
    @Query() query: DigestQueryInput,
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
  @ResponseSchema(reorderProposalResponseSchema)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:propose")
  @Validate({ body: reorderProposalBodySchema })
  getReorderProposal(
    @Body() body: z.infer<typeof reorderProposalBodySchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.proposals.propose(u, { variantId: body.variantId, warehouseId: body.warehouseId });
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
  @ResponseSchema(confirmReorderProposalResponseSchema)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:propose")
  @Idempotent("inventory.ai.reorder-proposal.confirm")
  @Validate({ body: confirmProposalBodySchema })
  confirmReorderProposal(
    @Body() body: z.infer<typeof confirmProposalBodySchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.proposals.confirm(u, { proposalId: body.proposalId, token: body.token });
  }

  @Get("supplier-delay")
  @ResponseSchema(supplierDelayBriefingResponseSchema)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:reports:read")
  @Validate({ query: supplierDelayQuerySchema })
  getSupplierDelayBriefing(
    @Query() query: SupplierDelayQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.getSupplierDelayBriefing(u.orgId, u.userId, query.vendorId);
  }
}
