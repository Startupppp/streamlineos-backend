import { ForbiddenException, UnauthorizedException, CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { AuthContext } from "../../common/auth/auth-context";
import { IS_PUBLIC } from "../../common/auth/public.decorator";
import { logger } from "../../common/logger/logger.service";
import { ModuleDisabledException } from "../../common/http/api-exceptions";
import { AccessService } from "./access.service";
import { namespaceOf } from "../../common/rbac/module-vocabulary";
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
    const permissionKey = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_PERMISSION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permissionKey) {
      const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (isPublic) return true;
      throw new ForbiddenException("Permission denied");
    }

    const req = context
      .switchToHttp()
      .getRequest<Request & { authContext?: AuthContext; rbacScope?: AuthResult["scope"] }>();

    let result: AuthResult;
    try {
      result = await authorize(this.access, req.authContext ?? null, permissionKey);
    } catch (error: unknown) {
      logger.error("PermissionGuard: unexpected error during authorization — denying", {
        permissionKey,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ForbiddenException("Permission denied");
    }

    if (!result.allow) {
      if (result.reason === "UNAUTHENTICATED") throw new UnauthorizedException("Unauthorized");
      // Same condition ModuleGuard reports, so it gets the same answer: 402 with
      // the module named. A 403 here reads as "you lack the permission" and the
      // frontend's EntitlementGate, which keys the upgrade prompt on 402, shows
      // an access-denied dead end instead of an offer to enable the module.
      if (result.reason === "NO_MODULE") throw new ModuleDisabledException(namespaceOf(permissionKey));
      throw new ForbiddenException("Permission denied");
    }

    req.rbacScope = result.scope;
    return true;
  }
}
