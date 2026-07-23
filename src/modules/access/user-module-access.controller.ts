import { Body, Controller, Get, Param, Patch, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RequirePermission } from "./require-permission.decorator";
import { PermissionGuard } from "./permission.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AccessService } from "./access.service";
import { z } from "zod";

const setModuleAccessSchema = z.object({
  moduleKey: z.string().min(1).max(64),
  enabled: z.boolean(),
});
type SetModuleAccessInput = z.infer<typeof setModuleAccessSchema>;

@Controller("access/user-module-access")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class UserModuleAccessController {
  constructor(private readonly access: AccessService) {}

  @Get(":userId")
  @RequirePermission("hr:employees:view")
  getModuleAccess(
    @Param("userId") userId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.access.getUserModuleAccess(u.orgId, userId);
  }

  @Patch(":userId")
  @RequirePermission("hr:employees:manage")
  setModuleAccess(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(setModuleAccessSchema))
    body: SetModuleAccessInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.access.setUserModuleAccess(
      u.orgId,
      userId,
      body.moduleKey,
      body.enabled,
      u.userId,
    );
  }
}
