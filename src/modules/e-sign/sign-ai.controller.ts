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
import { AccessService } from "../access/access.service";
import { SignAiService } from "./sign-ai.service";
import { resolveEnvelopeViewScope } from "./sign-envelope-scope";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

const envelopeIdParams = z.object({ envelopeId: z.coerce.number().int().positive() }).strict();

@RequireModule("sign")
@Controller("sign/envelopes/:envelopeId/ai")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard, RateLimitGuard)
@RequirePermission("sign:envelope:view")
@UseRateLimit("ai:invoke")
export class SignAiController {
  constructor(
    private readonly signAi: SignAiService,
    private readonly access: AccessService,
  ) {}

  @Post("summarize")
  @BodylessAction()
  @Validate({ params: envelopeIdParams })
  async summarize(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveEnvelopeViewScope(this.access, u);
    return this.signAi.summarizeDocument(u.orgId, envelopeId, u.userId, scope);
  }
}
