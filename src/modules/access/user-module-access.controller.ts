import { Body, Controller, Get, Param, Patch, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RequirePermission } from "./require-permission.decorator";
import { PermissionGuard } from "./permission.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { UserModuleAccessService } from "./user-module-access.service";
import {
  setUserModuleAccessSchema,
  userModuleAccessParamsSchema,
  type SetUserModuleAccessInput,
  type UserModuleAccessParams,
} from "./dto/user-module-access.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const userIdParams = z.object({ userId: z.string().min(1) }).strict();

@Controller("access/user-module-access")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class UserModuleAccessController {
  constructor(private readonly userModuleAccess: UserModuleAccessService) {}

  @Get(":userId")
  @RequirePermission("settings:view")
  @Validate({ params: userIdParams })
  getModuleAccess(
    @Param(new ZodValidationPipe(userModuleAccessParamsSchema))
    params: UserModuleAccessParams,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userModuleAccess.getUserModuleAccess(u.orgId, params.userId);
  }

  @Patch(":userId")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: userIdParams })
  setModuleAccess(
    @Param(new ZodValidationPipe(userModuleAccessParamsSchema))
    params: UserModuleAccessParams,
    @Body(new ZodValidationPipe(setUserModuleAccessSchema))
    body: SetUserModuleAccessInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userModuleAccess.setUserModuleAccess(
      u.orgId,
      params.userId,
      body.moduleKey,
      body.enabled,
      u.userId,
    );
  }
}
