import { ForbiddenException, UnauthorizedException, CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { IS_PUBLIC } from "../../common/auth/public.decorator";
import { logger } from "../../common/logger/logger.service";
import { AccessService } from "./access.service";
import { authorize } from "./authorize";
import type { AuthResult } from "./access.types";
import { REQUIRE_PERMISSION } from "./require-permission.decorator";

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const permissionKey = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_PERMISSION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permissionKey) throw new ForbiddenException("Permission denied");

    const req = context.switchToHttp().getRequest<Request & { user?: CurrentUserContext }>();

    let result: AuthResult;
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

    // Services read u.permissions for ad-hoc checks — hydrate from the DB-resolved set since the JWT no longer carries permission claims.
    if (req.user && result.permissions) {
      req.user.permissions = result.permissions;
    }

    req.rbacScope = result.scope;
    return true;
  }
}
