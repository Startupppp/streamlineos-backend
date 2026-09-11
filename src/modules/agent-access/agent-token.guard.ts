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

@Injectable()
export class AgentTokenGuard implements CanActivate {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly membership: MembershipStateService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: CurrentUserContext }>();
    const header = req.headers.authorization;
    if (!header?.startsWith(`Bearer ${AGENT_TOKEN_PREFIX}`))
      throw new UnauthorizedException("Unauthorized");
    const raw = header.slice("Bearer ".length).trim();
    const userCtx = await resolveAgentToken(this.db, this.membership, raw);
    if (!userCtx) throw new UnauthorizedException("Unauthorized");
    req.user = userCtx;
    return true;
  }
}
