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
import type { CreateApiTokenInput, ListApiTokensQuery } from "./dto/api-tokens.schemas";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBefore } from "../../../common/pagination/keyset";

const CRM_LEAD_INGEST_SCOPE = "leads:write";

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

    await this.dispatch.emit({
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
      .where(and(eq(apiKeys.id, tokenId), eq(apiKeys.orgId, orgId)))
      .limit(1);

    if (!existing) throw new NotFoundException("API token not found");
    if (existing.isRevoked) throw new ConflictException("API token is already revoked");

    await this.db
      .update(apiKeys)
      .set({ isRevoked: true })
      .where(and(eq(apiKeys.id, tokenId), eq(apiKeys.orgId, orgId)));

    return { success: true };
  }

}
