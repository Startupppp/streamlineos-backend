import { ForbiddenException, UnauthorizedException, CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { logger } from "../../common/logger/logger.service";
import { AccessService } from "./access.service";
import { authorize } from "./authorize";
import { REQUIRE_PERMISSION } from "./require-permission.decorator";

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permissionKey = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_PERMISSION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permissionKey) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: CurrentUserContext }>();

    let result;
    try {
      result = await authorize(this.access, req.user ?? null, permissionKey);
    } catch (error: unknown) {
      logger.error("PermissionGuard: unexpected error during authorization — denying", {
        permissionKey,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ForbiddenException("Permission denied");
    }

    if (!result.allow) {
      if (result.reason === "UNAUTHENTICATED") throw new UnauthorizedException("Unauthorized");
      if (result.reason === "NO_MODULE") throw new ForbiddenException("Module not available on this plan");
      throw new ForbiddenException("Permission denied");
    }

    req.rbacScope = result.scope;
    return true;
  }
}
