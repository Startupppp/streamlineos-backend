import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { OPERATOR_GRANT_KEY } from "./require-operator-grant.decorator";
import type { OperatorScope } from "./platform-operator-access.service";
import { PlatformOperatorAccessService } from "./platform-operator-access.service";
import { resolveClientIp } from "../../common/http/client-ip";

function ipOf(req: Request): string | undefined {
  return resolveClientIp(req);
}

function routePathOf(req: Request): string | undefined {
  const route: unknown = Reflect.get(req, "route");
  if (typeof route !== "object" || route === null) return undefined;
  const path: unknown = Reflect.get(route, "path");
  return typeof path === "string" ? path : undefined;
}

@Injectable()
export class OperatorSessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly operatorAccess: PlatformOperatorAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scope = this.reflector.getAllAndOverride<OperatorScope | undefined>(
      OPERATOR_GRANT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (scope === undefined) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: CurrentUserContext }>();
    const operator = req.user;
    if (!operator || operator.principal.kind !== "human-session")
      throw new UnauthorizedException("Operator must use an authenticated human session");

    const orgId = req.params["orgId"];
    if (typeof orgId !== "string" || !orgId)
      throw new BadRequestException("Route must declare :orgId route param for operator access");

    const route = routePathOf(req) ?? req.url;
    const action = `operator.${req.method.toLowerCase()}.${route}`;

    await this.operatorAccess.authorizeRequest(
      operator.userId,
      orgId,
      scope,
      action,
      ipOf(req),
    );

    operator.orgId = orgId;

    return true;
  }
}
