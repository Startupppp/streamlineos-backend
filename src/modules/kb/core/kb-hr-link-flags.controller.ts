import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { KbHrLinkFlagsService } from "./kb-hr-link-flags.service";
import {
  hrKbLinkFlagsAdminSchema,
  hrKbLinkFlagsSchema,
  updateHrKbLinkFlagsSchema,
  type UpdateHrKbLinkFlagsInput,
} from "./dto/kb-hr-link-flags.schemas";

/**
 * The switches for HR documents in the knowledge base. Two audiences, two routes: an administrator reads and
 * changes the stored switches, and every member reads the effective ones so the UI knows whether to render
 * the feature at all (employees cannot read `/settings/*` or `/kb/settings`).
 *
 * There is no module-gate decorator here: KB is a universal module and no KB controller carries one
 * (pinned by kb-module-gate.spec). The HR module is checked inside the service instead.
 */
@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbHrLinkFlagsController {
  constructor(private readonly flags: KbHrLinkFlagsService) {}

  @Get("hr-link/config")
  @RequirePermission("kb:pages:view")
  @ResponseSchema(hrKbLinkFlagsSchema)
  async config(@CurrentUser() u: CurrentUserContext) {
    return this.flags.getEffective(u.orgId);
  }

  @Get("settings/hr-link-flags")
  @RequirePermission("kb:settings:manage")
  @ResponseSchema(hrKbLinkFlagsAdminSchema)
  async getAdmin(@CurrentUser() u: CurrentUserContext) {
    return this.flags.getAdmin(u.orgId);
  }

  @Patch("settings/hr-link-flags")
  @RequirePermission("kb:settings:manage")
  @Validate({ body: updateHrKbLinkFlagsSchema })
  @ResponseSchema(hrKbLinkFlagsAdminSchema)
  async update(@Body() body: UpdateHrKbLinkFlagsInput, @CurrentUser() u: CurrentUserContext) {
    return this.flags.update(u, body);
  }
}
