import { Controller, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { SignAiService } from "./sign-ai.service";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

const envelopeIdParams = z.object({ envelopeId: z.coerce.number().int().positive() }).strict();

/**
 * The one sign controller that carried no module gate.
 *
 * Every other controller in this module pairs `@RequireModule("sign")` with
 * `ModuleGuard`; this one had neither, so an organisation without SignOS
 * enabled reached it on the strength of `sign:envelope:view` alone and got 403
 * only if it lacked that key. It is also the module's only AI route, so the
 * surface left open is the one that spends credits.
 */
@RequireModule("sign")
@Controller("sign/envelopes/:envelopeId/ai")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard, RateLimitGuard)
@RequirePermission("sign:envelope:view")
@UseRateLimit("ai:invoke")
export class SignAiController {
  constructor(private readonly signAi: SignAiService) {}

  @Post("summarize")
  @BodylessAction()
  @Validate({ params: envelopeIdParams })
  summarize(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.signAi.summarizeDocument(u.orgId, envelopeId, u.userId);
  }
}
