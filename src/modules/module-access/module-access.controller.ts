import { Body, Controller, Get, Param, Put, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ModuleAccessService } from "./module-access.service";
import {
  moduleKeyParamSchema,
  moduleRoleParamSchema,
  setModuleRolePermissionsSchema,
  type ModuleKeyParam,
  type ModuleRoleParam,
  type SetModuleRolePermissionsInput,
} from "./dto/module-access.schemas";

/**
 * Per-module Access API (plan §7.3). Authorization is dynamic on the route moduleKey and is
 * asserted inside the service (owner / org-admin / that module's admin), so these routes use
 * JwtAuthGuard only — the service is the deny-by-default gate.
 */
@Controller("module-access")
@UseGuards(JwtAuthGuard)
export class ModuleAccessController {
  constructor(private readonly svc: ModuleAccessService) {}

  @Get(":moduleKey/catalog")
  catalog(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listCatalog(u, params.moduleKey);
  }

  @Get(":moduleKey/roles")
  roles(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listRoles(u, params.moduleKey);
  }

  @Put(":moduleKey/roles/:roleId/permissions")
  setPermissions(
    @Param(new ZodValidationPipe(moduleRoleParamSchema)) params: ModuleRoleParam,
    @Body(new ZodValidationPipe(setModuleRolePermissionsSchema))
    body: SetModuleRolePermissionsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.setRolePermissions(u, params.moduleKey, params.roleId, body);
  }
}
