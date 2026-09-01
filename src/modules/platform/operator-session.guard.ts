import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { OPERATOR_GRANT_KEY } from "./require-operator-grant.decorator";
import type { OperatorScope } from "./platform-operator-access.service";
import { PlatformOperatorAccessService } from "./platform-operator-access.service";

function ipOf(req: Request): string | undefined {
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  return raw?.split(",")[0]?.trim() ?? req.ip ?? undefined;
}

@Injectable()
export class OperatorSessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly operatorAccess: PlatformOperatorAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scope = this.reflector.get<OperatorScope | undefined>(
      OPERATOR_GRANT_KEY,
      context.getHandler(),
    );
    if (scope === undefined) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: { userId?: string } }>();
    const operatorUserId = req.user?.userId;
    if (!operatorUserId) throw new UnauthorizedException("Operator must be authenticated via JWT");

    const orgId = req.params["orgId"];
    if (typeof orgId !== "string" || !orgId)
      throw new BadRequestException("Route must declare :orgId route param for operator access");

    const route = (req as unknown as { route?: { path?: string } }).route?.path ?? req.url;
    const action = `operator.${req.method.toLowerCase()}.${route}`;

    await this.operatorAccess.assertAndLog(operatorUserId, orgId, scope, action, ipOf(req));

    return true;
  }
}
