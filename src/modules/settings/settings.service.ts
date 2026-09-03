import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, like } from "drizzle-orm";
import { apiKeys, auditLogs, organizations, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { isStructuralOrgAdminContext } from "../../common/rbac/is-structural-org-admin";
import { OrgMembershipService } from "../organization/core/org-membership.service";
import { CacheService } from "../../common/cache/cache.service";
import {
  VALID_API_KEY_SCOPES,
  generateApiKey,
  parseOrgFeatureFlags,
} from "./settings.helpers";
import type { CreateApiKeyInput, FeatureFlagInput } from "./dto/settings.schemas";

@Injectable()
export class SettingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly orgMembership: OrgMembershipService,
    private readonly cache: CacheService,
  ) {}

  async getSectionProvenance(
    orgId: string,
    sections: readonly string[],
  ): Promise<
    Record<
      string,
      {
        actorId: string;
        actorName: string | null;
        action: string;
        at: string;
      } | null
    >
  > {
    const rows = await Promise.all(
      sections.map((section) =>
        this.db
          .select({
            action: auditLogs.action,
            actorId: auditLogs.userId,
            actorName: users.name,
            createdAt: auditLogs.createdAt,
          })
          .from(auditLogs)
          .leftJoin(users, eq(users.id, auditLogs.userId))
          .where(
            and(
              eq(auditLogs.orgId, orgId),
              like(auditLogs.action, `${section}.%`),
            ),
          )
          .orderBy(desc(auditLogs.createdAt))
          .limit(1),
      ),
    );

    return Object.fromEntries(
      sections.map((section, index) => {
        const row = rows[index]?.[0];
        return [
          section,
          row
            ? {
                actorId: row.actorId,
                actorName: row.actorName,
                action: row.action,
                at: row.createdAt.toISOString(),
              }
            : null,
        ];
      }),
    );
  }

  async listApiKeys(u: CurrentUserContext) {
    if (!isStructuralOrgAdminContext(u)) {
      throw new ForbiddenException("Only admins can manage API keys.");
    }
    return this.db.query.apiKeys.findMany({
      where: and(eq(apiKeys.orgId, u.orgId), eq(apiKeys.isRevoked, false)),
      columns: { keyHash: false },
      with: { creator: { columns: { name: true, email: true } } },
      orderBy: (t, { desc: d }) => [d(t.createdAt)],
    });
  }

  async createApiKey(u: CurrentUserContext, input: CreateApiKeyInput) {
    if (!isStructuralOrgAdminContext(u)) {
      throw new ForbiddenException("Only admins can create API keys.");
    }

    const invalidScopes = input.scopes.filter(
      (s) => !VALID_API_KEY_SCOPES.includes(s as (typeof VALID_API_KEY_SCOPES)[number]),
    );
    if (invalidScopes.length > 0) {
      throw new BadRequestException(
        `Invalid scopes: ${invalidScopes.join(", ")}. Valid scopes: ${VALID_API_KEY_SCOPES.join(", ")}`,
      );
    }

    const { id, rawKey, keyHash, keyPrefix } = generateApiKey();

    await this.db.insert(apiKeys).values({
      id,
      orgId: u.orgId,
      name: input.name,
      description: input.description,
      keyHash,
      keyPrefix,
      scopes: input.scopes,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdBy: u.userId,
    });

    return { id, key: rawKey, keyPrefix, name: input.name, scopes: input.scopes };
  }

  async revokeApiKey(u: CurrentUserContext, keyId: string) {
    if (!isStructuralOrgAdminContext(u)) {
      throw new ForbiddenException("Only admins can revoke API keys.");
    }

    const existing = await this.db.query.apiKeys.findFirst({
      columns: { id: true },
      where: and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, u.orgId)),
    });
    if (!existing) throw new NotFoundException("API key not found.");

    await this.db
      .update(apiKeys)
      .set({ isRevoked: true })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, u.orgId)));
    return { success: true };
  }

  async getFeatureFlags(orgId: string) {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { settings: true },
    });
    return parseOrgFeatureFlags(org?.settings ?? null);
  }

  async updateFeatureFlag(u: CurrentUserContext, input: FeatureFlagInput) {
    if (!isStructuralOrgAdminContext(u)) {
      throw new ForbiddenException("Forbidden");
    }

    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, u.orgId),
      columns: { settings: true },
    });
    const currentSettings = (org?.settings ?? {}) as Record<string, unknown>;
    const currentFeatures = (currentSettings.features ?? {}) as Record<string, unknown>;

    await this.db
      .update(organizations)
      .set({
        settings: {
          ...currentSettings,
          features: { ...currentFeatures, [input.flag]: input.enabled },
        },
      })
      .where(eq(organizations.id, u.orgId));

    await Promise.all([
      this.cache.invalidateForOrg(u.orgId, "org:settings"),
      this.cache.invalidateNamespaceForOrg(u.orgId, "org:profile"),
    ]);

    return { success: true, flag: input.flag, enabled: input.enabled };
  }

  /**
   * The published `/settings` path, served by the organization membership
   * service that owns the operation.
   *
   * This handler used to be a second implementation of the same write, reached
   * through a *different* permission key, and it was the weaker of the two: no
   * `FOR UPDATE` on the member row, no last-structural-admin check, no
   * module-ownership check, no audit entry and no role-changed notification. A
   * caller who held `settings:rbac:manage` could therefore demote the last
   * org admin and orphan a module's ownership — through a route the
   * organization module already refuses. Two mechanisms for one job; the
   * rewrite absorbs this one rather than standing beside it.
   */
  async updateUserRole(u: CurrentUserContext, targetUserId: string, role: string) {
    await this.orgMembership.updateMemberRole(
      u.orgId,
      { userId: u.userId, isOrgOwner: u.isOrgOwner },
      targetUserId,
      role,
    );
    return { success: true, userId: targetUserId, role };
  }
}
