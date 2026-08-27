import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { agentTokens } from "../../db/schema";
import { crmMcpTokenGrants } from "../../db/schema/crm/crm-mcp";
import { AuditService } from "../../common/audit/audit.service";
import { ALL_PERMISSION_NAMES } from "../rbac/permissions";
import { isPersonalTokenPermissionDelegable } from "../../common/rbac/personal-token-policy";

/**
 * What one agent token may do over the protocol, and nothing about the token itself.
 *
 * Ticket 19's second criterion. The credential is `agent_tokens` — its secret,
 * its expiry and its revocation all stay there, and revoking it revokes every
 * grant below with it, because `AgentTokenGuard` never resolves a revoked token
 * at all. This service adds the one thing that table has no column for.
 *
 * The gap it fills is specific and was worth confirming before filling it.
 * `AgentTokenGuard` builds a `CurrentUserContext` with `tokenScopes: null`, and
 * null means UNRESTRICTED to `AccessService.scopeFor` — so an agent token
 * inherits its owner's whole permission set, and one issued by an organisation
 * owner holds everything. The enforcement is not missing: `scopeFor` checks
 * `tokenScopes` BEFORE the `isOrgOwner` shortcut, which is how personal access
 * tokens are already scoped. Only the values were absent. This service supplies
 * them, and `crm-mcp.service.ts` puts them on the context so the existing check
 * does the work.
 */

const KNOWN_KEYS = new Set<string>(ALL_PERMISSION_NAMES);

@Injectable()
export class CrmMcpGrantsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** This token's grant, read on every protocol call. */
  async scopesFor(orgId: string, agentTokenId: number): Promise<string[]> {
    const rows = await this.db
      .select({ permissionKey: crmMcpTokenGrants.permissionKey })
      .from(crmMcpTokenGrants)
      .where(
        and(
          eq(crmMcpTokenGrants.organizationId, orgId),
          eq(crmMcpTokenGrants.agentTokenId, agentTokenId),
        ),
      );

    return rows.map((row) => row.permissionKey);
  }

  /**
   * Replace a token's grant with exactly this list.
   *
   * A whole replacement rather than add and remove. Two administrators editing
   * a grant by deltas converge on the union of what they each intended, and the
   * error is always in the direction of more access than either chose. A
   * replacement's races are lost writes, which are visible on the next read.
   */
  async replace(
    orgId: string,
    agentTokenId: number,
    actorUserId: string,
    permissions: readonly string[],
  ): Promise<string[]> {
    const token = await this.db
      .select({ id: agentTokens.id, userId: agentTokens.userId })
      .from(agentTokens)
      .where(and(eq(agentTokens.id, agentTokenId), eq(agentTokens.orgId, orgId)))
      .limit(1);
    if (token.length === 0) throw new NotFoundException("Agent token not found");

    const wanted = [...new Set(permissions)].sort();

    /*
      A key nobody catalogued is refused here rather than stored.

      `authorize()` denies an uncatalogued key before anything else looks at it,
      so storing one would be inert — but it would still render as access on the
      screen an administrator uses to decide what this token may do, and a
      permission list that shows something it does not grant is worse than one
      that refuses to be written. This is the same argument `authorize.ts` makes
      for its own catalogue check, one layer earlier.
    */
    const uncatalogued = wanted.filter((key) => !KNOWN_KEYS.has(key));
    if (uncatalogued.length > 0)
      throw new BadRequestException(
        `No such permission: ${uncatalogued.join(", ")}`,
      );

    /*
      Account and organisation administration is interactive-only, and the
      platform already says so: `isPersonalTokenPermissionDelegable` is what
      makes `billing:`, `ownership:` and `settings:` undelegable to a personal
      access token. An agent token is a machine credential for the same reasons,
      so it gets the same answer from the same function rather than a second
      list that would drift from it.
    */
    const undelegable = wanted.filter((key) => !isPersonalTokenPermissionDelegable(key));
    if (undelegable.length > 0)
      throw new BadRequestException(
        `These permissions cannot be delegated to a token: ${undelegable.join(", ")}`,
      );

    const before = await this.scopesFor(orgId, agentTokenId);

    await this.db.transaction(async (tx) => {
      await tx
        .delete(crmMcpTokenGrants)
        .where(
          and(
            eq(crmMcpTokenGrants.organizationId, orgId),
            eq(crmMcpTokenGrants.agentTokenId, agentTokenId),
          ),
        );

      if (wanted.length > 0)
        await tx.insert(crmMcpTokenGrants).values(
          wanted.map((permissionKey) => ({
            organizationId: orgId,
            agentTokenId,
            permissionKey,
            grantedBy: actorUserId,
          })),
        );
    });

    // Critical rather than best-effort: this row is the record of a human
    // deciding what a machine may do, and it has to survive the same failures
    // the grant itself survives.
    await this.audit.logCritical({
      action: "crm.mcp.token.scopes.set",
      userId: actorUserId,
      orgId,
      actorUserId,
      targetType: "agent_token",
      targetId: String(agentTokenId),
      resourceType: "agent_token",
      resourceId: String(agentTokenId),
      result: "SUCCESS",
      before: { permissions: before.sort() },
      after: { permissions: wanted },
      metadata: { moduleKey: "crm", protocol: "mcp", tokenOwnerId: token[0].userId },
    });

    return wanted;
  }
}
