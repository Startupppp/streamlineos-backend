import { Body, Controller, Get, Put, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { CrmMcpSettingsService } from "./crm-mcp-settings.service";

const setMcpEnabledSchema = z.object({ enabled: z.boolean() }).strict();
type SetMcpEnabledInput = z.infer<typeof setMcpEnabledSchema>;

/**
 * The switch, on its own controller and its own route.
 *
 * Deliberately not on `crm/mcp`, which carries `@AllowAgentToken()`. An agent
 * must not be able to read or change whether agents are allowed — a credential
 * that could turn its own access back on is not a switch, and putting the
 * routes beside each other is how that happens by accident later.
 *
 * `settings:api-tokens:write` rather than a CRM key, because it is the same
 * authority that mints the credentials this surface accepts. Splitting them
 * would let somebody grant agent access without being able to issue a token, or
 * the reverse — two halves of one decision behind two different grants. The
 * read pairs with `:read` for the same reason.
 */
@RequireModule("crm")
@Controller("crm/settings/mcp")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmMcpSettingsController {
  constructor(private readonly settings: CrmMcpSettingsService) {}

  @Get()
  @RequirePermission("settings:api-tokens:read")
  read(@CurrentUser() u: CurrentUserContext) {
    return this.settings.read(u.orgId);
  }

  @Put()
  @RequirePermission("settings:api-tokens:write")
  setEnabled(
    @Body(new ZodValidationPipe(setMcpEnabledSchema)) body: SetMcpEnabledInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.setEnabled(u.orgId, u.userId, body.enabled);
  }
}
