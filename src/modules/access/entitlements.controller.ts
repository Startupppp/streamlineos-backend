import { Body, Controller, Get, Param, Patch, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PermissionGuard } from "./permission.guard";
import { RequirePermission } from "./require-permission.decorator";
import { EntitlementsService } from "./entitlements.service";

const moduleKeyParamSchema = z.object({
  moduleKey: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
});

const toggleModuleSchema = z.object({
  enabled: z.boolean(),
});

type ModuleKeyParam = z.infer<typeof moduleKeyParamSchema>;
type ToggleModuleInput = z.infer<typeof toggleModuleSchema>;

@Controller("access/org-modules")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EntitlementsController {
  constructor(private readonly entitlements: EntitlementsService) {}

  @Get()
  @RequirePermission("settings:manage")
  listModules(@CurrentUser() u: CurrentUserContext): Promise<Array<{ moduleKey: string; enabled: boolean }>> {
    return this.entitlements.listModules(u.orgId);
  }

  @Patch(":moduleKey")
  @RequirePermission("settings:manage")
  toggleModule(
    @Param(new ZodValidationPipe(moduleKeyParamSchema)) params: ModuleKeyParam,
    @Body(new ZodValidationPipe(toggleModuleSchema)) body: ToggleModuleInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    return this.entitlements.setModuleEnabled(u.orgId, params.moduleKey, body.enabled, u.userId);
  }
}
