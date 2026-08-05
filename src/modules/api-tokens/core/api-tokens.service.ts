import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { apiKeys } from "../../../db/schema/common/auth";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { CreateApiTokenInput, ListApiTokensQuery } from "./dto/api-tokens.schemas";

const CRM_LEAD_INGEST_SCOPE = "leads:write";

@Injectable()
export class ApiTokensService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async listTokens(orgId: string, query: ListApiTokensQuery) {
    const offset = (query.page - 1) * query.limit;

    const [rows, [{ count }]] = await Promise.all([
      this.db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          description: apiKeys.description,
          keyPrefix: apiKeys.keyPrefix,
          scopes: apiKeys.scopes,
          isRevoked: apiKeys.isRevoked,
          lastUsedAt: apiKeys.lastUsedAt,
          expiresAt: apiKeys.expiresAt,
          createdBy: apiKeys.createdBy,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.orgId, orgId))
        .orderBy(desc(apiKeys.createdAt))
        .limit(query.limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(apiKeys)
        .where(eq(apiKeys.orgId, orgId)),
    ]);

    return {
      data: rows,
      meta: {
        page: query.page,
        limit: query.limit,
        total: count,
        totalPages: Math.ceil(count / query.limit),
      },
    };
  }

  async createToken(orgId: string, userId: string, input: CreateApiTokenInput) {
    const rawKey = `sk_${randomBytes(32).toString("hex")}`;
    const keyPrefix = rawKey.slice(0, 10);
    const keyHash = createHash("sha256").update(rawKey).digest("hex");

    const [created] = await this.db
      .insert(apiKeys)
      .values({
        id: randomUUID(),
        orgId,
        name: input.name,
        description: input.description,
        keyHash,
        keyPrefix,
        scopes: [CRM_LEAD_INGEST_SCOPE],
        expiresAt: input.expiresAt ?? null,
        createdBy: userId,
      })
      .returning({
        id: apiKeys.id,
        name: apiKeys.name,
        description: apiKeys.description,
        keyPrefix: apiKeys.keyPrefix,
        scopes: apiKeys.scopes,
        isRevoked: apiKeys.isRevoked,
        lastUsedAt: apiKeys.lastUsedAt,
        expiresAt: apiKeys.expiresAt,
        createdBy: apiKeys.createdBy,
        createdAt: apiKeys.createdAt,
      });

    void this.dispatch.emit({
      eventKey: "security.api_key.created",
      orgId,
      actorUserId: userId,
      targetUserIds: [userId],
      entityType: "api_key",
      entityId: created.id,
      title: "New CRM API key created",
      message: `A new CRM lead-ingestion key "${input.name}" was created. If you did not do this, revoke it immediately.`,
      link: "/crm/api-keys",
    }).catch(() => undefined);

    return { token: rawKey, apiKey: created };
  }

  async revokeToken(orgId: string, tokenId: string) {
    const [existing] = await this.db
      .select({ id: apiKeys.id, orgId: apiKeys.orgId, isRevoked: apiKeys.isRevoked })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, tokenId), eq(apiKeys.orgId, orgId)));

    if (!existing) throw new NotFoundException("API token not found");
    if (existing.isRevoked) throw new ConflictException("API token is already revoked");

    await this.db
      .update(apiKeys)
      .set({ isRevoked: true })
      .where(and(eq(apiKeys.id, tokenId), eq(apiKeys.orgId, orgId)));

    return { success: true };
  }

}
