import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { userApiTokens } from "../../../db/schema/common/auth";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  apiTokenDisplayPrefix,
  generateApiToken,
  hashApiToken,
} from "../../../common/auth/api-token-hash";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { CreateUserApiTokenInput } from "./dto/user-api-tokens.schemas";

@Injectable()
export class UserApiTokensService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async create(userId: string, orgId: string, input: CreateUserApiTokenInput) {
    const rawToken = generateApiToken();

    const [row] = await this.db
      .insert(userApiTokens)
      .values({
        id: randomUUID(),
        userId,
        name: input.name,
        tokenHash: hashApiToken(rawToken),
        hashAlg: "sha256",
        prefix: apiTokenDisplayPrefix(rawToken),
        scopes: input.scopes,
        expiresAt: input.expiresAt ?? null,
      })
      .returning({
        id: userApiTokens.id,
        userId: userApiTokens.userId,
        name: userApiTokens.name,
        prefix: userApiTokens.prefix,
        scopes: userApiTokens.scopes,
        expiresAt: userApiTokens.expiresAt,
        lastUsedAt: userApiTokens.lastUsedAt,
        createdAt: userApiTokens.createdAt,
      });

    void this.dispatch.emit({
      eventKey: "security.api_key.created",
      orgId,
      actorUserId: userId,
      targetUserIds: [userId],
      entityType: "api_key",
      entityId: row.id,
      title: "New personal API token created",
      message: `A new personal API token "${input.name}" was created on your account. If you did not do this, revoke it immediately.`,
      link: "/settings/security",
    }).catch(() => undefined);

    return { ...row, rawToken };
  }

  async list(userId: string) {
    return this.db
      .select({
        id: userApiTokens.id,
        userId: userApiTokens.userId,
        name: userApiTokens.name,
        prefix: userApiTokens.prefix,
        scopes: userApiTokens.scopes,
        expiresAt: userApiTokens.expiresAt,
        lastUsedAt: userApiTokens.lastUsedAt,
        createdAt: userApiTokens.createdAt,
      })
      .from(userApiTokens)
      .where(
        and(eq(userApiTokens.userId, userId), isNull(userApiTokens.revokedAt)),
      );
  }

  async revoke(userId: string, tokenId: string) {
    const [revoked] = await this.db
      .update(userApiTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userApiTokens.id, tokenId),
          eq(userApiTokens.userId, userId),
          isNull(userApiTokens.revokedAt),
        ),
      )
      .returning({ id: userApiTokens.id });

    if (!revoked) throw new NotFoundException("API token not found");

    return { success: true };
  }
}
