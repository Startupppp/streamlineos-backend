import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { IS_PUBLIC } from "./public.decorator";
import { ALLOW_WITHOUT_MFA } from "./allow-without-mfa.decorator";
import type { CurrentUserContext } from "./backend-claims";
import { MfaPolicyService } from "../../modules/access/mfa-policy.service";

@Injectable()
export class MfaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly mfaPolicy: MfaPolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;

    const exempt = this.reflector.getAllAndOverride<boolean>(
      ALLOW_WITHOUT_MFA,
      [context.getHandler(), context.getClass()],
    );
    if (exempt) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: CurrentUserContext }>();
    const user = req.user;
    if (!user?.userId || !user.orgId) return true;

    const { enforced, satisfied } = await this.mfaPolicy.resolve(
      user.orgId,
      user.userId,
    );
    if (enforced && !satisfied) {
      throw new ForbiddenException({
        code: "MFA_REQUIRED",
        message:
          "Your organization requires two-factor authentication. Set it up to continue.",
      });
    }

    return true;
  }
}
