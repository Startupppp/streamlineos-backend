import { createHash } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { agentTokens } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { withPublicToken } from "../tenant/with-public-token";
import { runInTenantTransaction } from "../tenant/run-in-tenant-transaction";
import type { MembershipStateService } from "./membership-state.service";
import type { CurrentUserContext } from "./backend-claims";
import { agentTokenPrincipal } from "./principal";

/**
 * The credential prefix `agent_tokens` rows are minted with.
 *
 * `AgentTokensService.create` builds every token as `"slos_" + 24 random
 * bytes`, and this is the only thing that tells an agent token apart from a
 * session JWT or a personal access token at the point a request arrives.
 */
export const AGENT_TOKEN_PREFIX = "slos_";

export function isAgentTokenCredential(rawToken: string): boolean {
  return rawToken.startsWith(AGENT_TOKEN_PREFIX);
}

/**
 * Resolves a `slos_` bearer credential to a caller, or null.
 *
 * This lives here, apart from `AgentTokenGuard`, because it now has two
 * callers: that guard (on `/agent/v1`) and `JwtAuthGuard` (on routes that opt
 * in with `@AllowAgentToken()`). Duplicating it would have created two readers
 * of `agent_tokens` that could disagree about revocation, expiry or the
 * issuer-membership re-check — the same class of silent drift between two
 * individually-correct halves that CRM-P1-16 was.
 *
 * The returned context carries an `agent-token` principal, so
 * `AccessService.scopeFor` clamps every subsequent permission answer to the
 * token's own scopes rather than to everything its issuer happens to hold.
 */
export async function resolveAgentToken(
  db: Db,
  membership: MembershipStateService,
  rawToken: string,
): Promise<CurrentUserContext | null> {
  const hash = createHash("sha256").update(rawToken).digest("hex");
  const now = new Date();

  const row = await withPublicToken(db, hash, (tx) =>
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

  const state = await membership.resolve(row.userId, row.orgId);
  if (!state.active || state.membershipId === null) return null;
  if (state.membershipId !== row.issuerMembershipId) return null;

  await runInTenantTransaction(
    db,
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
    principal: agentTokenPrincipal(row.issuerMembershipId, row.id, row.scopes),
  };
}
