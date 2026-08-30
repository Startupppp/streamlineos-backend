import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, isNull, or } from "drizzle-orm";
import { agentTokens, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AccessService } from "../access/access.service";
import { isPersonalTokenPermissionDelegable } from "../../common/rbac/personal-token-policy";
import { AuditService } from "../../common/audit/audit.service";
import type { CreateAgentTokenInput } from "./dto/agent-tokens.schemas";
import { AGENT_TOKEN_DEFAULT_CEILING } from "./agent-token-ceiling";

const TOKEN_CAP = 10;

@Injectable()
export class AgentTokensService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  private async resolveIssuerMembership(
    orgId: string,
    userId: string,
  ): Promise<number> {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    if (!member) {
      throw new ForbiddenException(
        "An agent token can only be issued by an active member of this organization",
      );
    }
    return member.id;
  }

  private async resolveCeiling(
    orgId: string,
    userId: string,
    requested: readonly string[] | undefined,
  ): Promise<string[]> {
    const held = await this.access.resolveUserPermissions(orgId, userId);
    const holds = (key: string): boolean =>
      isPersonalTokenPermissionDelegable(key) &&
      (held.get(key) ?? "none") !== "none";

    if (requested === undefined) {
      return AGENT_TOKEN_DEFAULT_CEILING.filter(holds);
    }

    const unheld = requested.filter((key) => !holds(key));
    if (unheld.length > 0) {
      throw new ForbiddenException(
        `A token cannot be issued with a capability its issuer does not hold: ${unheld.slice(0, 5).join(", ")}`,
      );
    }
    return [...new Set(requested)];
  }

  async create(userId: string, orgId: string, input: CreateAgentTokenInput) {
    const now = new Date();
    const issuerMembershipId = await this.resolveIssuerMembership(orgId, userId);
    const scopes = await this.resolveCeiling(orgId, userId, input.scopes);
    if (scopes.length === 0) {
      throw new BadRequestException(
        "The issuer holds none of the requested capabilities, so the token would be able to do nothing",
      );
    }

    const activeCountRows = await this.db
      .select({ total: count() })
      .from(agentTokens)
      .where(
        and(
          eq(agentTokens.orgId, orgId),
          eq(agentTokens.issuerMembershipId, issuerMembershipId),
          isNull(agentTokens.revokedAt),
          or(isNull(agentTokens.expiresAt), gt(agentTokens.expiresAt, now)),
        ),
      );

    const active = Number(activeCountRows[0]?.total ?? 0);
    if (active >= TOKEN_CAP) {
      throw new ConflictException(`Maximum of ${TOKEN_CAP} active agent tokens allowed per user`);
    }

    const raw = "slos_" + randomBytes(24).toString("hex");
    const tokenHash = createHash("sha256").update(raw).digest("hex");
    const tokenPrefix = raw.slice(0, 10);

    const expiresAt = input.expiresInDays
      ? new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const [row] = await this.db
      .insert(agentTokens)
      .values({
        orgId,
        userId,
        issuerMembershipId,
        scopes,
        name: input.name,
        tokenHash,
        tokenPrefix,
        expiresAt,
      })
      .returning({
        id: agentTokens.id,
        name: agentTokens.name,
        tokenPrefix: agentTokens.tokenPrefix,
        scopes: agentTokens.scopes,
        expiresAt: agentTokens.expiresAt,
        createdAt: agentTokens.createdAt,
      });

    if (!row) throw new Error("Insert returned no rows");

    this.audit.log({
      action: "agent_token.issued",
      userId,
      orgId,
      targetId: String(row.id),
      targetType: "agent_token",
      metadata: {
        tokenId: row.id,
        tokenPrefix: row.tokenPrefix,
        issuerMembershipId,
        scopes: row.scopes,
        expiresAt,
      },
    });

    return {
      token: raw,
      id: row.id,
      name: row.name,
      tokenPrefix: row.tokenPrefix,
      scopes: row.scopes,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  }

  list(userId: string, orgId: string) {
    return this.db
      .select({
        id: agentTokens.id,
        name: agentTokens.name,
        tokenPrefix: agentTokens.tokenPrefix,
        scopes: agentTokens.scopes,
        lastUsedAt: agentTokens.lastUsedAt,
        expiresAt: agentTokens.expiresAt,
        revokedAt: agentTokens.revokedAt,
        createdAt: agentTokens.createdAt,
      })
      .from(agentTokens)
      .where(and(eq(agentTokens.userId, userId), eq(agentTokens.orgId, orgId)))
      .limit(100);
  }

  async revoke(userId: string, orgId: string, tokenId: number) {
    const existing = await this.db.query.agentTokens.findFirst({
      where: and(eq(agentTokens.id, tokenId), eq(agentTokens.userId, userId), eq(agentTokens.orgId, orgId)),
      columns: { id: true, issuerMembershipId: true, tokenPrefix: true },
    });
    if (!existing) throw new NotFoundException("Agent token not found");

    await this.db
      .update(agentTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(agentTokens.id, tokenId), eq(agentTokens.userId, userId), eq(agentTokens.orgId, orgId)));

    this.audit.log({
      action: "agent_token.revoked",
      userId,
      orgId,
      targetId: String(tokenId),
      targetType: "agent_token",
      metadata: {
        tokenId,
        tokenPrefix: existing.tokenPrefix,
        issuerMembershipId: existing.issuerMembershipId,
      },
    });
  }
}
