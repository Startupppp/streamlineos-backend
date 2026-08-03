import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { REQUIRE_MODULE } from "./require-module.decorator";
import { ModuleDisabledException } from "../http/api-exceptions";
import type { CurrentUserContext } from "../auth/backend-claims";
import { EntitlementsService } from "../../modules/access/entitlements.service";
import { AccessService } from "../../modules/access/access.service";
import { grantsOrgAdmin } from "./grantability";

@Injectable()
export class ModuleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_MODULE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const req = context.switchToHttp().getRequest<Request & { user: CurrentUserContext }>();
    const user = req.user;
    if (user.isOrgOwner) return true;

    const resolved = await this.access.resolveUserPermissions(user.orgId, user.userId);
    if (grantsOrgAdmin(resolved)) return true;

    const moduleKey = required.toLowerCase();
    const enabled = await this.entitlements.isModuleEnabled(user.orgId, moduleKey);
    if (!enabled) {
      throw new ModuleDisabledException(required);
    }
    return true;
  }
}
