import { Body, Controller, Get, HttpCode, Param, Patch, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { PermissionGuard } from "./permission.guard";
import { RequirePermission } from "./require-permission.decorator";
import { EntitlementsService, ModuleStatus } from "./entitlements.service";
import { Validate } from "../../common/validation/validate.decorator";

const moduleKeyParamSchema = z.object({
  moduleKey: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
});

const toggleModuleSchema = z.object({
  enabled: z.boolean(),
});

type ToggleModuleInput = z.infer<typeof toggleModuleSchema>;

@Controller("access/org-modules")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EntitlementsController {
  constructor(private readonly entitlements: EntitlementsService) {}

  @Get()
  @RequirePermission("settings:manage")
  listModules(@CurrentUser() u: CurrentUserContext): Promise<ModuleStatus[]> {
    return this.entitlements.listModules(u.orgId);
  }

  @Patch(":moduleKey")
  @RequirePermission("settings:manage")
  @HttpCode(204)
  @Validate({ params: moduleKeyParamSchema, body: toggleModuleSchema })
  toggleModule(
    @Param("moduleKey") moduleKey: string,
    @Body() body: ToggleModuleInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    return this.entitlements.setModuleEnabled(u.orgId, moduleKey, body.enabled, u.userId);
  }
}
