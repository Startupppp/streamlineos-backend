import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
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
import type {
  CreateUserApiTokenInput,
  ListUserApiTokensInput,
} from "./dto/user-api-tokens.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { grantablePersonalTokenPermissions } from "./personal-token-scope-policy";

@Injectable()
export class UserApiTokensService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
    private readonly access: AccessService,
  ) {}

  async listGrantablePermissions(user: CurrentUserContext) {
    const snapshot = await this.access.getAccessSnapshot(
      user.orgId,
      user.userId,
      user,
    );
    return grantablePersonalTokenPermissions(snapshot);
  }

  async create(user: CurrentUserContext, input: CreateUserApiTokenInput) {
    const grantable = await this.listGrantablePermissions(user);
    const allowed = new Set(grantable.map((permission) => permission.name));
    const denied = input.scopes.filter((scope) => !allowed.has(scope));
    if (denied.length > 0) {
      throw new ForbiddenException(
        "One or more selected permissions are unavailable for personal tokens",
      );
    }

    const rawToken = generateApiToken();

    const [row] = await this.db
      .insert(userApiTokens)
      .values({
        id: randomUUID(),
        userId: user.userId,
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

    void this.dispatch
      .emit({
        eventKey: "security.api_key.created",
        orgId: user.orgId,
        actorUserId: user.userId,
        targetUserIds: [user.userId],
        entityType: "api_key",
        entityId: row.id,
        title: "New personal API token created",
        message: `A new personal API token "${input.name}" was created on your account. If you did not do this, revoke it immediately.`,
        link: "/settings/api-tokens",
      })
      .catch(() => undefined);

    return { ...row, rawToken };
  }

  async list(userId: string, query: ListUserApiTokensInput) {
    const filters = and(
      eq(userApiTokens.userId, userId),
      isNull(userApiTokens.revokedAt),
    );
    const offset = (query.page - 1) * query.limit;
    const [data, [{ total }]] = await Promise.all([
      this.db
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
        .where(filters)
        .orderBy(desc(userApiTokens.createdAt), desc(userApiTokens.id))
        .limit(query.limit)
        .offset(offset),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(userApiTokens)
        .where(filters),
    ]);

    return {
      data,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
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
