import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { CHECK_ABILITY, type RequiredAbility } from "./check-ability.decorator";
import { defineAbilityFor } from "./abilities.factory";
import { AbilityDeniedException } from "../http/api-exceptions";
import { logger } from "../logger/logger.service";
import type { CurrentUserContext } from "../auth/backend-claims";

@Injectable()
export class AbilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<RequiredAbility | undefined>(CHECK_ABILITY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const req = context.switchToHttp().getRequest<Request & { user: CurrentUserContext }>();
    const user = req.user;
    const ability = defineAbilityFor({
      isPlatformAdmin: user.isPlatformAdmin,
      isOrgOwner: user.isOrgOwner,
      permissions: user.permissions,
      enabledModules: user.enabledModules,
    });
    if (!ability.can(required.verb, required.subject)) {
      logger.warn("RBAC_DENIED", {
        userId: user.userId,
        orgId: user.orgId,
        required: `${required.verb}:${required.subject}`,
        path: req.path,
        method: req.method,
      });
      throw new AbilityDeniedException(required.verb, required.subject);
    }
    return true;
  }
}
