import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { REQUIRE_MODULE } from "./require-module.decorator";
import { ModuleDisabledException } from "../http/api-exceptions";
import { IS_PUBLIC } from "../auth/public.decorator";
import type { AuthContext } from "../auth/auth-context";
import type { CurrentUserContext } from "../auth/backend-claims";
import { moduleIdFromStored } from "./module-registry";

@Injectable()
export class ModuleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<
      string | readonly string[] | undefined
    >(REQUIRE_MODULE, [context.getHandler(), context.getClass()]);
    if (!required) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<
      Request & {
        authContext?: AuthContext;
        user?: Pick<CurrentUserContext, "userId">;
      }
    >();
    const authContext = req.authContext;
    if (!authContext) {
      if (req.user)
        throw new ForbiddenException({
          code: "MODULE_ENTITLEMENT_UNRESOLVED",
          message:
            "Module entitlement could not be resolved for this request.",
        });
      return true;
    }

    const moduleKeys = (Array.isArray(required) ? required : [required]).map(
      moduleIdFromStored,
    );
    for (const moduleKey of moduleKeys) {
      const avail = await authContext.moduleAvailable(moduleKey);
      if (!avail.available) throw new ModuleDisabledException(moduleKey, avail.reason);
    }
    return true;
  }
}
