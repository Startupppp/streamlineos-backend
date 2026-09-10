import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { IS_PUBLIC } from "./public.decorator";
import { ALLOW_WITHOUT_MFA } from "./allow-without-mfa.decorator";
import type { CurrentUserContext } from "./backend-claims";
import type { AuthContext } from "./auth-context";
import { MFA_POLICY, type IMfaPolicy } from "./mfa-policy.token";

@Injectable()
export class MfaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(MFA_POLICY) private readonly mfaPolicy: IMfaPolicy,
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
      .getRequest<
        Request & { user?: CurrentUserContext; authContext?: AuthContext }
      >();
    const user = req.user;
    if (!user?.userId || !user.orgId) return true;

    const ctx = req.authContext;
    // No context, or one bound to another actor, asks the policy directly.
    const shared =
      ctx && ctx.actor.userId === user.userId && ctx.actor.orgId === user.orgId
        ? ctx
        : null;
    const { enforced, satisfied } = shared
      ? await shared.mfa()
      : await this.mfaPolicy.resolve(user.orgId, user.userId);
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
