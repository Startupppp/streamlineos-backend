import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, isNull, or } from "drizzle-orm";
import { agentTokens } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { CreateAgentTokenInput } from "./dto/agent-tokens.schemas";

const TOKEN_CAP = 10;

@Injectable()
export class AgentTokensService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async create(userId: string, orgId: string, input: CreateAgentTokenInput) {
    const now = new Date();
    const activeCountRows = await this.db
      .select({ total: count() })
      .from(agentTokens)
      .where(
        and(
          eq(agentTokens.userId, userId),
          eq(agentTokens.orgId, orgId),
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
      .values({ orgId, userId, name: input.name, tokenHash, tokenPrefix, expiresAt })
      .returning({
        id: agentTokens.id,
        name: agentTokens.name,
        tokenPrefix: agentTokens.tokenPrefix,
        expiresAt: agentTokens.expiresAt,
        createdAt: agentTokens.createdAt,
      });

    return { token: raw, id: row.id, name: row.name, tokenPrefix: row.tokenPrefix, expiresAt: row.expiresAt, createdAt: row.createdAt };
  }

  list(userId: string, orgId: string) {
    return this.db
      .select({
        id: agentTokens.id,
        name: agentTokens.name,
        tokenPrefix: agentTokens.tokenPrefix,
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
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Agent token not found");

    await this.db
      .update(agentTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(agentTokens.id, tokenId), eq(agentTokens.userId, userId), eq(agentTokens.orgId, orgId)));
  }
}
