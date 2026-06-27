import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "./access.service";
import { requirePermission } from "./authorize";
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
    await requirePermission(this.access, req.user ?? null, permissionKey);
    return true;
  }
}
