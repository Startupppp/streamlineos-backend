import { Body, Controller, HttpCode, Post, UseGuards, UseInterceptors } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { NoTenantTransaction } from "../../../common/tenant/no-tenant-transaction.decorator";
import { AiRequestAbortInterceptor } from "../../ai/core/streaming";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbAuthoringService } from "./kb-authoring.service";
import {
  draftSchema,
  improveSchema,
  summarizeSchema,
  type DraftInput,
  type ImproveInput,
  type SummarizeInput,
} from "./dto/kb-authoring.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

/**
 * Every handler here carries `@NoTenantTransaction()`. `KbAuthoringService.run`
 * awaits `gateway.invokeTextWithUsage`, a network round trip to an AI provider,
 * and with the request transaction open that pooled connection is idle in
 * transaction for the whole of it. `withTenant` sets
 * `idle_in_transaction_session_timeout` to 60s, so a slow provider does not
 * merely make one request slow — the server kills the transaction while the
 * borrow is still outstanding, which under pool pressure is a tenant-wide
 * failure shape rather than a latency one.
 *
 * Nothing here reads a tenant row before the provider call: the prompt is built
 * entirely from the request body, and the only database touch is the
 * `kb_events` write afterwards, which `KbEventsService.record` now opens its own
 * short tenant transaction for. The decorator also removes the tenant context's
 * disconnect signal that `getAmbientAiAbortSignal` was reading, hence
 * `AiRequestAbortInterceptor` on the class — the AI module's own convention for
 * a metered route outside a request transaction, and the same pairing
 * `KbArticleAiController` uses.
 */
@Controller("kb/ai")
@UseGuards(JwtAuthGuard, PermissionGuard)
@UseInterceptors(AiRequestAbortInterceptor)
@RequireModule("kb")
export class KbAuthoringController {
  constructor(private readonly authoring: KbAuthoringService) {}

  @Post("draft")
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("kb:ai:generate")
  @Validate({ body: draftSchema })
  async draft(
    @Body() body: DraftInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.authoring.draft(u, body);
  }

  @Post("improve")
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("kb:ai:generate")
  @Validate({ body: improveSchema })
  async improve(
    @Body() body: ImproveInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.authoring.improve(u, body);
  }

  @Post("summarize")
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("kb:ai:generate")
  @Validate({ body: summarizeSchema })
  async summarize(
    @Body() body: SummarizeInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.authoring.summarize(u, body);
  }

}
