import { CanActivate, ExecutionContext, Injectable, Optional } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { REQUIRE_MODULE } from "./require-module.decorator";
import { ModuleDisabledException } from "../http/api-exceptions";
import { IS_PUBLIC } from "../auth/public.decorator";
import type { CurrentUserContext } from "../auth/backend-claims";
import { EntitlementsService } from "../../modules/access/entitlements.service";
import { AccessService } from "../../modules/access/access.service";
import { moduleIdFromStored } from "./module-registry";
import {
  moduleAvailability,
  moduleAvailabilityResolver,
  type ModuleAvailabilityResolver,
} from "./module-availability";

@Injectable()
export class ModuleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
    @Optional() private readonly accessSvc?: AccessService,
  ) {}

  private buildResolver(): ModuleAvailabilityResolver {
    return moduleAvailabilityResolver(this.entitlements, this.accessSvc);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<
      string | readonly string[] | undefined
    >(REQUIRE_MODULE, [context.getHandler(), context.getClass()]);
    if (!required) return true;

    /**
     * A `@Public()` route has no `req.user` to read an org from, so reaching the
     * entitlement lookup threw and every such route 500'd — inbound support
     * webhooks, public CSAT and whiteboard sharing all sit on classes carrying
     * `@RequireModule`. `JwtAuthGuard` and `MfaGuard` already skip on this key.
     */
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: CurrentUserContext }>();
    const user = req.user;
    if (!user) return true;

    const moduleKeys = (Array.isArray(required) ? required : [required]).map(
      moduleIdFromStored,
    );
    for (const moduleKey of moduleKeys) {
      const avail = await moduleAvailability(
        this.buildResolver(),
        user.orgId,
        user.userId,
        moduleKey,
      );
      if (!avail.available) throw new ModuleDisabledException(moduleKey);
    }
    return true;
  }
}
