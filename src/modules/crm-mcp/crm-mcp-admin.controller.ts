import { Body, Controller, Get, Param, ParseIntPipe, Put, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CRM_CAPABILITIES } from "./capabilities/crm-capabilities";
import { CrmMcpEnablementService } from "./crm-mcp-enablement.service";
import { CrmMcpGrantsService } from "./crm-mcp-grants.service";
import {
  setMcpEnablementSchema,
  setTokenScopesSchema,
  type SetMcpEnablementInput,
  type SetTokenScopesInput,
} from "./dto/crm-mcp.schemas";

/**
 * Where a human decides whether the machine doorway is open, and how wide.
 *
 * Ticket 19's last criterion needs somewhere for "enabled deliberately" to
 * happen, and this is it. Deliberately separated from the protocol surface in
 * every way that matters: a different controller, a different guard chain, a
 * different credential. `crm:settings:manage` is a key an agent token can never
 * hold — `isPersonalTokenPermissionDelegable` refuses to delegate it, and
 * `CrmMcpGrantsService.replace` refuses to store it — so the surface that
 * decides what agents may do is one no agent can reach.
 *
 * That is the fifth criterion at the level of routes rather than of code: an
 * agent acts within permissions it holds, and the endpoints that change those
 * permissions are on the other side of a credential it cannot obtain.
 *
 * There is no frontend for this yet. The endpoints are here and gated; the
 * settings screen that calls them is not part of this ticket's files.
 *
 * `crm:settings:manage` is written out at each route rather than held in a
 * shared constant, for the reason `attribution.controller.ts` gives: the
 * catalogue guard's scan reads the decorator's literal and counts the gates it
 * cannot resolve.
 */
@Controller("crm/mcp/admin")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmMcpAdminController {
  constructor(
    private readonly enablement: CrmMcpEnablementService,
    private readonly grants: CrmMcpGrantsService,
  ) {}

  /**
   * The whole picture: whether it is on, who turned it on, and what could be
   * granted.
   *
   * The catalogue is served in full here — unlike `tools/list`, which shows an
   * agent only what its own token may call — because this is the screen where
   * somebody decides what to grant, and a picker that hides the options is not
   * a picker.
   */
  @Get()
  @RequirePermission("crm:settings:manage")
  async overview(@CurrentUser() user: CurrentUserContext) {
    return {
      server: await this.enablement.state(user.orgId),
      capabilities: CRM_CAPABILITIES.map((capability) => ({
        name: capability.name,
        description: capability.description,
        permission: capability.permission,
        mutates: capability.mutates,
      })),
    };
  }

  @Put("enablement")
  @RequirePermission("crm:settings:manage")
  setEnablement(
    @Body(new ZodValidationPipe(setMcpEnablementSchema)) body: SetMcpEnablementInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.enablement.set(user.orgId, user.userId, body.enabled);
  }

  @Get("tokens/:tokenId/scopes")
  @RequirePermission("crm:settings:manage")
  async scopes(
    @Param("tokenId", ParseIntPipe) tokenId: number,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return { permissions: await this.grants.scopesFor(user.orgId, tokenId) };
  }

  @Put("tokens/:tokenId/scopes")
  @RequirePermission("crm:settings:manage")
  async setScopes(
    @Param("tokenId", ParseIntPipe) tokenId: number,
    @Body(new ZodValidationPipe(setTokenScopesSchema)) body: SetTokenScopesInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return {
      permissions: await this.grants.replace(
        user.orgId,
        tokenId,
        user.userId,
        body.permissions,
      ),
    };
  }
}
