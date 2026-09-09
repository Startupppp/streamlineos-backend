import { Controller, Get, Post, Body, UseGuards } from "@nestjs/common";
import { AuthorizedInService } from "../../../common/auth/authorized-in-service.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { AllowAgentToken } from "../../../common/auth/allow-agent-token.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CrmMcpService, type McpToolCall } from "./crm-mcp.service";

/**
 * CRM-P1-16.
 *
 * `@AllowAgentToken()` is what makes the credential this product hands out for
 * this server one the server accepts. `/crm/settings/mcp` mints `slos_` agent
 * tokens from `POST /agent-tokens`; until this declaration existed they were
 * refused 401 here, before scopes were ever considered, because `JwtAuthGuard`
 * only reads `user_api_tokens` and the agent rows live in `agent_tokens`.
 *
 * `JwtAuthGuard` stays, and stays first: it still resolves session JWTs and
 * personal access tokens exactly as before, so the interactive caller behind
 * the settings page is unaffected. The two credentials compose inside that one
 * guard rather than through a second stacked one, which could not have worked —
 * Nest runs APP_GUARDs before controller guards, so `JwtAuthGuard` would have
 * refused a `slos_` token before any controller-level `AgentTokenGuard` ran.
 */
@Controller("crm/mcp")
@UseGuards(JwtAuthGuard)
@AllowAgentToken()
export class CrmMcpController {
  constructor(private readonly crmMcpService: CrmMcpService) {}

  /**
   * Authorized per tool, not per route.
   *
   * Every tool carries its own `requiredPermission`; `getAvailableTools` filters
   * the catalogue by what the caller holds and `executeTool` re-checks before it
   * runs. A single `@RequirePermission` here would have to name one key for a
   * surface whose whole point is that the key differs per tool, and it would
   * advertise a second, weaker way in.
   *
   * The caller is handed down whole rather than reduced to `{ userId, orgId }`.
   * That pair cannot express which credential is asking, and the answer differs:
   * an agent token is clamped to its own scopes, a session is not.
   */
  @AuthorizedInService("CrmMcpService")
  @Get("tools")
  async listTools(@CurrentUser() user: CurrentUserContext) {
    const tools = await this.crmMcpService.getAvailableTools(user);
    return { tools };
  }

  @AuthorizedInService("CrmMcpService")
  @Post("call")
  async callTool(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: McpToolCall,
  ) {
    return this.crmMcpService.executeTool(user, body);
  }
}
