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
import { InvCopilotService } from "./inv-copilot.service";
import { invCopilotAskSchema, type InvCopilotAskInput } from "./dto/inv-copilot.schemas";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { copilotAskResponseSchema } from "./dto/inv-copilot-response.schemas";

/**
 * F2 — the copilot's one route.
 *
 * A POST because it may spend credits, so it happens because a human pressed
 * something; no page render reaches it. It is gated on `inventory:ai:read` and
 * nothing else, because it reads and only reads — every tool behind it is a
 * SELECT, and there is no confirm, no proposal and no mutation on this path at
 * all. A route that cannot write does not need a write key, and giving it one
 * would misdescribe what it does.
 *
 * Object-level visibility is not enforced here. It cannot be: the answer spans
 * many rows across seven queries, so the gate lives in the SQL predicate of
 * each one, bound to `@CurrentUser()`'s org and the asker's warehouse scope.
 */
@RequireModule("inventory")
@Controller("inventory/ai/copilot")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvCopilotController {
  constructor(private readonly copilot: InvCopilotService) {}

  @Post("ask")
  @ResponseSchema(copilotAskResponseSchema)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:read")
  ask(
    @Body(new ZodValidationPipe(invCopilotAskSchema)) body: InvCopilotAskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.copilot.ask(u, body);
  }
}
