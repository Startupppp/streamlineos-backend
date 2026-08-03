import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import type { Request } from "express";
import { agentTokens, organizationMembers, organizations, subscriptions, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { withPublicToken } from "../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { EntitlementsService } from "../access/entitlements.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

@Injectable()
export class AgentTokenGuard implements CanActivate {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: CurrentUserContext }>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer slos_")) throw new UnauthorizedException("Unauthorized");
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

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        void tx
          .update(agentTokens)
          .set({ lastUsedAt: now })
          .where(eq(agentTokens.id, row.id))
          .catch(() => undefined);

        const [user, memberRows] = await Promise.all([
          tx.query.users.findFirst({
            where: eq(users.id, row.userId),
            columns: { id: true },
          }),
          tx
            .select({
              orgId: organizationMembers.orgId,
              role: organizationMembers.role,
              isOwner: organizationMembers.isOwner,
            })
            .from(organizationMembers)
            .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
            .where(and(eq(organizationMembers.userId, row.userId), eq(organizationMembers.orgId, row.orgId)))
            .orderBy(desc(organizationMembers.joinedAt)),
        ]);

        if (!user) return null;

        const member = memberRows[0];
        if (!member) return null;

        return {
          userId: row.userId,
          orgId: row.orgId,
          role: member.role,
          permissions: [],
          isOrgOwner: member.isOwner,
          sessionId: `agent-token:${row.id}`,
          tokenScopes: null,
        };
      },
      { orgId: row.orgId },
    );
  }
}
