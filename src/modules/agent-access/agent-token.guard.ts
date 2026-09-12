import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { MembershipStateService } from "../../common/auth/membership-state.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  AGENT_TOKEN_PREFIX,
  resolveAgentToken,
} from "../../common/auth/agent-token-resolution";
import { AuthContextFactory } from "../../common/auth/auth-context.factory";
import type { AuthContext } from "../../common/auth/auth-context";

@Injectable()
export class AgentTokenGuard implements CanActivate {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly membership: MembershipStateService,
    private readonly authContexts: AuthContextFactory,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: CurrentUserContext; authContext?: AuthContext }>();
    const header = req.headers.authorization;
    if (!header?.startsWith(`Bearer ${AGENT_TOKEN_PREFIX}`))
      throw new UnauthorizedException("Unauthorized");
    const raw = header.slice("Bearer ".length).trim();
    const userCtx = await resolveAgentToken(this.db, this.membership, raw);
    if (!userCtx) throw new UnauthorizedException("Unauthorized");
    req.user = userCtx;
    /*
     * PermissionGuard authorizes against the request's AuthContext and answers
     * 401 when there is none. This controller is @Public(), so the global
     * JwtAuthGuard never runs here to attach one; without this line every
     * agent/v1 route would refuse a valid token.
     */
    req.authContext = this.authContexts.create(userCtx);
    return true;
  }
}
