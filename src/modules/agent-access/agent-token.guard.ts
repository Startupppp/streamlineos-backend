import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { Request } from "express";
import { agentTokens } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { withPublicToken } from "../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { MembershipStateService } from "../../common/auth/membership-state.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { agentTokenPrincipal } from "../../common/auth/principal";

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
    if (!header?.startsWith("Bearer slos_"))
      throw new UnauthorizedException("Unauthorized");
    const raw = header.slice("Bearer ".length).trim();
    const userCtx = await this.resolveToken(raw);
    if (!userCtx) throw new UnauthorizedException("Unauthorized");
    req.user = userCtx;
    return true;
  }

  private async resolveToken(raw: string): Promise<CurrentUserContext | null> {
    const hash = createHash("sha256").update(raw).digest("hex");
    const now = new Date();

    const row = await withPublicToken(this.db, hash, (tx) =>
      tx
        .select({
          id: agentTokens.id,
          userId: agentTokens.userId,
          orgId: agentTokens.orgId,
          issuerMembershipId: agentTokens.issuerMembershipId,
          scopes: agentTokens.scopes,
        })
        .from(agentTokens)
        .where(
          and(
            eq(agentTokens.tokenHash, hash),
            isNull(agentTokens.revokedAt),
            or(isNull(agentTokens.expiresAt), gt(agentTokens.expiresAt, now)),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    );
    if (!row) return null;

    const state = await this.membership.resolve(row.userId, row.orgId);
    if (!state.active || state.membershipId === null) return null;
    if (state.membershipId !== row.issuerMembershipId) return null;

    await runInTenantTransaction(
      this.db,
      (tx) =>
        tx
          .update(agentTokens)
          .set({ lastUsedAt: now })
          .where(eq(agentTokens.id, row.id))
          .catch(() => undefined),
      { orgId: row.orgId },
    );

    return {
      userId: row.userId,
      orgId: row.orgId,
      role: state.role,
      isOrgOwner: state.isOwner,
      sessionId: `agent-token:${row.id}`,
      tokenScopes: [...row.scopes],
      principal: agentTokenPrincipal(
        row.issuerMembershipId,
        row.id,
        row.scopes,
      ),
    };
  }
}
