import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import * as bcrypt from "bcryptjs";
import { userApiTokens } from "../../../db/schema/common/auth";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { CreateUserApiTokenInput } from "./dto/user-api-tokens.schemas";

@Injectable()
export class UserApiTokensService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async create(userId: string, orgId: string, input: CreateUserApiTokenInput) {
    const rawToken = randomBytes(32).toString("hex");
    const prefix = rawToken.slice(0, 8);
    const tokenHash = await bcrypt.hash(rawToken, 12);

    const [row] = await this.db
      .insert(userApiTokens)
      .values({
        id: randomUUID(),
        userId,
        name: input.name,
        tokenHash,
        prefix,
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
      .where(eq(userApiTokens.userId, userId));
  }

  async revoke(userId: string, tokenId: string) {
    const [existing] = await this.db
      .select({ id: userApiTokens.id })
      .from(userApiTokens)
      .where(and(eq(userApiTokens.id, tokenId), eq(userApiTokens.userId, userId)));

    if (!existing) throw new NotFoundException("API token not found");

    await this.db
      .delete(userApiTokens)
      .where(and(eq(userApiTokens.id, tokenId), eq(userApiTokens.userId, userId)));

    return { success: true };
  }

  async validatePat(rawToken: string): Promise<string | null> {
    const prefix = rawToken.slice(0, 8);

    const rows = await this.db
      .select({
        id: userApiTokens.id,
        userId: userApiTokens.userId,
        tokenHash: userApiTokens.tokenHash,
        expiresAt: userApiTokens.expiresAt,
      })
      .from(userApiTokens)
      .where(eq(userApiTokens.prefix, prefix));

    for (const row of rows) {
      if (row.expiresAt && row.expiresAt < new Date()) continue;

      const valid = await bcrypt.compare(rawToken, row.tokenHash);
      if (!valid) continue;

      await this.db
        .update(userApiTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(userApiTokens.id, row.id));

      return row.userId;
    }

    return null;
  }
}
