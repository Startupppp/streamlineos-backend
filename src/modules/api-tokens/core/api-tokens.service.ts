import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { apiKeys } from "../../../db/schema";
import { generateApiToken } from "./api-token-key";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { commitAccessChange } from "../../../common/rbac/access-mutation-commit";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { CreateApiTokenInput, ListApiTokensQuery } from "./dto/api-tokens.schemas";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBefore } from "../../../common/pagination/keyset";

const CRM_LEAD_INGEST_SCOPE = "leads:write";

const apiKeyProjection = {
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
};

export interface MintedApiKey {
  id: string;
  keyHash: string;
  keyPrefix: string;
}

export interface ApiKeyFields {
  name: string;
  description?: string | null;
  scopes: string[];
  expiresAt: Date | null;
}

export type ApiKeyRevocation = "revoked" | "already-revoked";

function decodeApiTokenCursor(cursor: string | undefined, orgId: string) {
  if (!cursor) return null;

  const position = decodeCursor(cursor);
  if (!position) throw new BadRequestException("Invalid pagination cursor");

  let scope: unknown;
  try {
    scope = JSON.parse(position.id);
  } catch {
    throw new BadRequestException("Invalid pagination cursor");
  }

  if (
    !Array.isArray(scope) ||
    scope.length !== 2 ||
    scope[0] !== orgId ||
    typeof scope[1] !== "string" ||
    scope[1].length === 0
  ) {
    throw new BadRequestException("Invalid pagination cursor");
  }

  return { sortValue: position.sortValue, id: scope[1] };
}

@Injectable()
export class ApiTokensService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async listTokens(orgId: string, query: ListApiTokensQuery) {
    const cursor = decodeApiTokenCursor(query.cursor, orgId);
    const filters = [eq(apiKeys.orgId, orgId)];
    if (cursor) filters.push(keysetBefore(apiKeys.createdAt, apiKeys.id, cursor));

    const rows = await this.db
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
      .where(and(...filters))
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
      .limit(query.limit + 1);

    return buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: JSON.stringify([orgId, row.id]),
    }));
  }

  async createToken(orgId: string, userId: string, input: CreateApiTokenInput) {
    const { rawKey, keyPrefix, keyHash } = generateApiToken();
    const apiKey = await this.issue(
      orgId,
      userId,
      {
        name: input.name,
        description: input.description,
        scopes: [CRM_LEAD_INGEST_SCOPE],
        expiresAt: input.expiresAt ?? null,
      },
      { id: randomUUID(), keyHash, keyPrefix },
    );
    return { token: rawKey, apiKey };
  }

  async revokeToken(orgId: string, actorUserId: string, tokenId: string) {
    const outcome = await this.revoke(orgId, actorUserId, tokenId);
    if (outcome === "already-revoked")
      throw new ConflictException("API token is already revoked");
    return { success: true };
  }

  async issue(orgId: string, userId: string, fields: ApiKeyFields, minted: MintedApiKey) {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const [created] = await tx
          .insert(apiKeys)
          .values({
            id: minted.id,
            orgId,
            name: fields.name,
            description: fields.description,
            keyHash: minted.keyHash,
            keyPrefix: minted.keyPrefix,
            scopes: fields.scopes,
            expiresAt: fields.expiresAt,
            createdBy: userId,
          })
          .returning(apiKeyProjection);
        await commitAccessChange(tx, orgId, {
          audit: {
            action: "api_key.created",
            userId,
            targetId: minted.id,
            targetType: "api_key",
            metadata: { name: fields.name, scopes: fields.scopes, keyPrefix: minted.keyPrefix },
          },
          notify: {
            via: this.dispatch,
            events: [
              {
                eventKey: "security.api_key.created",
                orgId,
                actorUserId: userId,
                targetUserIds: [userId],
                entityType: "api_key",
                entityId: minted.id,
                title: "New API key created",
                message: `A new API key "${fields.name}" was created. If you did not do this, revoke it immediately.`,
                link: "/crm/api-keys",
              },
            ],
          },
        });
        return created;
      },
      { orgId },
    );
  }

  async revoke(orgId: string, actorUserId: string, keyId: string): Promise<ApiKeyRevocation> {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const [existing] = await tx
          .select({ id: apiKeys.id, isRevoked: apiKeys.isRevoked })
          .from(apiKeys)
          .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId)))
          .for("update")
          .limit(1);
        if (!existing) throw new NotFoundException("API token not found");
        if (existing.isRevoked) return "already-revoked";

        await tx
          .update(apiKeys)
          .set({ isRevoked: true })
          .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId)));
        await commitAccessChange(tx, orgId, {
          audit: {
            action: "api_key.revoked",
            userId: actorUserId,
            targetId: keyId,
            targetType: "api_key",
          },
        });
        return "revoked";
      },
      { orgId },
    );
  }
}
