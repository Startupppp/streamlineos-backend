import { Controller, Param, ParseIntPipe, Post, UseGuards, UseInterceptors } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AiRequestAbortInterceptor } from "../ai/core/streaming";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { NoTenantTransaction } from "../../common/tenant/no-tenant-transaction.decorator";
import { AccessService } from "../access/access.service";
import { SignAiService } from "./sign-ai.service";
import { resolveEnvelopeViewScope } from "./sign-envelope-scope";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { signAiSummarizeResponseSchema } from "./dto/e-sign-response.schemas";

const envelopeIdParams = z.object({ envelopeId: z.coerce.number().int().positive() }).strict();

@RequireModule("sign")
@Controller("sign/envelopes/:envelopeId/ai")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard, RateLimitGuard)
@UseInterceptors(AiRequestAbortInterceptor)
@RequirePermission("sign:envelope:view")
@UseRateLimit("ai:invoke")
export class SignAiController {
  constructor(
    private readonly signAi: SignAiService,
    private readonly access: AccessService,
  ) {}

  /**
   * `@NoTenantTransaction()` because the work behind this handler is three
   * things a pooled database connection must not be held across: an object-store
   * fetch and full stream drain per document, a CPU-bound text extraction, and
   * an LLM call. Under the request transaction the connection stayed checked out
   * and idle-in-transaction for all three (backend CLAUDE.md §4, PRD-C078/C147).
   * `SignAiService.summarizeDocument` now opens its own tenant transaction for
   * the envelope and document reads and commits it before any of that begins,
   * and `AccessService`, the AI gateway's credit ledger and its usage log each
   * pass an explicit `orgId`, so nothing here reaches the pool without a GUC.
   *
   * The opt-out also removes the tenant context's disconnect signal, which is
   * the only thing `getAmbientAiAbortSignal` had to read on this route — hence
   * `@UseInterceptors(AiRequestAbortInterceptor)` on the class. Without it the
   * released connection would have been paid for with an uncancellable provider
   * call: a client that hangs up mid-summary still gets billed for tokens
   * nobody reads (PRD-C091). Same pairing as `KbAuthoringController`.
   */
  @Post("summarize")
  @BodylessAction()
  @NoTenantTransaction()
  @ResponseSchema(signAiSummarizeResponseSchema)
  @Validate({ params: envelopeIdParams })
  async summarize(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveEnvelopeViewScope(this.access, u);
    return this.signAi.summarizeDocument(u.orgId, envelopeId, u.userId, scope);
  }
}
