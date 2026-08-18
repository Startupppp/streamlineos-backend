import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  apiKeys,
  automationRules,
  automationRuns,
  customFieldDefinitions,
  gitConnections,
  organizations,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { queryAiUsage } from "./ai-usage.query";
import { PERMISSIONS } from "../rbac/permissions";
import { AccessService } from "../access/access.service";
import { assertMayGrantRole } from "../../common/rbac/assert-may-grant-role";
import { syncStructuralRoleAssignment } from "../../common/rbac/sync-structural-role";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { CacheService } from "../../common/cache/cache.service";
import { bustMembershipStatusCache } from "../../common/auth/membership-state.service";
import {
  VALID_API_KEY_SCOPES,
  generateApiKey,
  generateWebhookSecret,
  gitWebhookUrl,
  maskSecret,
  parseOrgFeatureFlags,
} from "./settings.helpers";
import type {
  CreateApiKeyInput,
  CreateAutomationInput,
  CreateCustomFieldInput,
  CreateGitConnectionInput,
  FeatureFlagInput,
  ListAutomationsQueryInput,
  UpdateAutomationInput,
  UpdateCustomFieldInput,
  UpdateGitConnectionInput,
} from "./dto/settings.schemas";

@Injectable()
export class SettingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly planLimits: PlanLimitsService,
    private readonly access: AccessService,
    private readonly cache: CacheService,
  ) {}

  getPermissions() {
    return PERMISSIONS;
  }

  getAiUsage(u: CurrentUserContext) {
    if (!u.isOrgOwner) {
      throw new ForbiddenException("Forbidden");
    }
    return queryAiUsage(this.db, u.orgId);
  }

  async listApiKeys(u: CurrentUserContext) {
    if (!u.isOrgOwner) {
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
    if (!u.isOrgOwner) {
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
    if (!u.isOrgOwner) {
      throw new ForbiddenException("Only admins can revoke API keys.");
    }

    const existing = await this.db.query.apiKeys.findFirst({
      where: and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, u.orgId)),
    });
    if (!existing) throw new NotFoundException("API key not found.");

    await this.db.update(apiKeys).set({ isRevoked: true }).where(eq(apiKeys.id, keyId));
    return { success: true };
  }

  async listAutomations(orgId: string, params: ListAutomationsQueryInput) {
    const limit = Math.min(params.limit, 100);
    const offset = (params.page - 1) * limit;
    const where = eq(automationRules.orgId, orgId);

    const [data, countRows] = await Promise.all([
      this.db
        .select({
          id: automationRules.id,
          name: automationRules.name,
          description: automationRules.description,
          triggerEvent: automationRules.triggerEvent,
          conditions: automationRules.conditions,
          actions: automationRules.actions,
          isEnabled: automationRules.isEnabled,
          runCount: automationRules.runCount,
          lastRunAt: automationRules.lastRunAt,
          createdAt: automationRules.createdAt,
          updatedAt: automationRules.updatedAt,
        })
        .from(automationRules)
        .where(where)
        .orderBy(desc(automationRules.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(automationRules)
        .where(where),
    ]);

    const total = countRows[0]?.total ?? 0;

    return {
      data,
      pagination: { page: params.page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async createAutomation(orgId: string, userId: string, input: CreateAutomationInput) {
    await this.planLimits.assertWithinLimit(orgId, "automations");
    const [rule] = await this.db
      .insert(automationRules)
      .values({
        orgId,
        name: input.name,
        description: input.description ?? null,
        triggerEvent: input.triggerEvent,
        conditions: input.conditions,
        actions: input.actions,
        isEnabled: input.isEnabled,
        createdBy: userId,
      })
      .returning();

    return rule;
  }

  async getAutomation(orgId: string, ruleId: number) {
    const rule = await this.db.query.automationRules.findFirst({
      where: and(eq(automationRules.id, ruleId), eq(automationRules.orgId, orgId)),
    });
    if (!rule) throw new NotFoundException("Automation not found");
    return rule;
  }

  async updateAutomation(orgId: string, ruleId: number, input: UpdateAutomationInput) {
    const [updated] = await this.db
      .update(automationRules)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.triggerEvent !== undefined ? { triggerEvent: input.triggerEvent } : {}),
        ...(input.conditions !== undefined ? { conditions: input.conditions } : {}),
        ...(input.actions !== undefined ? { actions: input.actions } : {}),
        ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(automationRules.id, ruleId), eq(automationRules.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Automation not found");
    return updated;
  }

  async deleteAutomation(orgId: string, ruleId: number) {
    const [deleted] = await this.db
      .delete(automationRules)
      .where(and(eq(automationRules.id, ruleId), eq(automationRules.orgId, orgId)))
      .returning({ id: automationRules.id });

    if (!deleted) throw new NotFoundException("Automation not found");
    return { success: true };
  }

  async listAutomationRuns(orgId: string, ruleId: number) {
    const rule = await this.db.query.automationRules.findFirst({
      where: and(eq(automationRules.id, ruleId), eq(automationRules.orgId, orgId)),
      columns: { id: true },
    });
    if (!rule) throw new NotFoundException("Automation not found");

    return this.db
      .select({
        id: automationRuns.id,
        triggerEvent: automationRuns.triggerEvent,
        status: automationRuns.status,
        payload: automationRuns.payload,
        result: automationRuns.result,
        error: automationRuns.error,
        createdAt: automationRuns.createdAt,
      })
      .from(automationRuns)
      .where(and(eq(automationRuns.ruleId, ruleId), eq(automationRuns.orgId, orgId)))
      .orderBy(desc(automationRuns.createdAt))
      .limit(50);
  }

  async listCustomFields(orgId: string, entityType?: string) {
    const where = entityType
      ? and(
          eq(customFieldDefinitions.orgId, orgId),
          eq(customFieldDefinitions.entityType, entityType),
        )
      : eq(customFieldDefinitions.orgId, orgId);

    const fields = await this.db
      .select()
      .from(customFieldDefinitions)
      .where(where)
      .orderBy(asc(customFieldDefinitions.displayOrder), asc(customFieldDefinitions.createdAt));

    return { fields };
  }

  async createCustomField(orgId: string, userId: string, input: CreateCustomFieldInput) {
    const existing = await this.db
      .select({ id: customFieldDefinitions.id })
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.orgId, orgId),
          eq(customFieldDefinitions.entityType, input.entityType),
          eq(customFieldDefinitions.key, input.name),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      throw new ConflictException(
        `A field named "${input.name}" already exists for ${input.entityType}`,
      );
    }

    const [created] = await this.db
      .insert(customFieldDefinitions)
      .values({
        orgId,
        entityType: input.entityType,
        key: input.name,
        label: input.label,
        fieldType: input.fieldType,
        options: input.options ?? null,
        isRequired: input.isRequired ?? false,
        isActive: true,
        displayOrder: input.sortOrder ?? 0,
      })
      .returning();

    return { field: created };
  }

  async updateCustomField(orgId: string, fieldId: number, input: UpdateCustomFieldInput) {
    const [existing] = await this.db
      .select({ id: customFieldDefinitions.id })
      .from(customFieldDefinitions)
      .where(and(eq(customFieldDefinitions.id, fieldId), eq(customFieldDefinitions.orgId, orgId)))
      .limit(1);

    if (!existing) throw new NotFoundException("Field not found");

    const [updated] = await this.db
      .update(customFieldDefinitions)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(customFieldDefinitions.id, fieldId), eq(customFieldDefinitions.orgId, orgId)))
      .returning();

    return { field: updated };
  }

  async deleteCustomField(orgId: string, fieldId: number) {
    const [existing] = await this.db
      .select({ id: customFieldDefinitions.id })
      .from(customFieldDefinitions)
      .where(and(eq(customFieldDefinitions.id, fieldId), eq(customFieldDefinitions.orgId, orgId)))
      .limit(1);

    if (!existing) throw new NotFoundException("Field not found");

    await this.db
      .delete(customFieldDefinitions)
      .where(and(eq(customFieldDefinitions.id, fieldId), eq(customFieldDefinitions.orgId, orgId)));

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
    if (!u.isOrgOwner) {
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

    return { success: true, flag: input.flag, enabled: input.enabled };
  }

  async listGitConnections(orgId: string) {
    const rows = await this.db
      .select()
      .from(gitConnections)
      .where(eq(gitConnections.orgId, orgId))
      .orderBy(desc(gitConnections.id));

    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      projectId: row.projectId,
      repoUrl: row.repoUrl,
      repoName: row.repoName,
      isActive: row.isActive,
      maskedSecret: maskSecret(row.webhookSecret),
      webhookUrl: gitWebhookUrl(row.id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async createGitConnection(orgId: string, userId: string, input: CreateGitConnectionInput) {
    const secret = generateWebhookSecret();

    const [created] = await this.db
      .insert(gitConnections)
      .values({
        orgId,
        provider: input.provider,
        repoUrl: input.repoUrl,
        repoName: input.repoName ?? null,
        projectId: input.projectId ?? null,
        webhookSecret: secret,
        createdBy: userId,
      })
      .returning();

    return {
      id: created.id,
      provider: created.provider,
      projectId: created.projectId,
      repoUrl: created.repoUrl,
      repoName: created.repoName,
      isActive: created.isActive,
      webhookUrl: gitWebhookUrl(created.id),
      webhookSecret: secret,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    };
  }

  async updateGitConnection(orgId: string, connectionId: number, input: UpdateGitConnectionInput) {
    if (
      input.isActive === undefined &&
      input.repoUrl === undefined &&
      input.repoName === undefined &&
      input.projectId === undefined
    ) {
      throw new BadRequestException("No fields to update");
    }

    const [updated] = await this.db
      .update(gitConnections)
      .set({
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.repoUrl !== undefined ? { repoUrl: input.repoUrl } : {}),
        ...(input.repoName !== undefined ? { repoName: input.repoName } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(gitConnections.id, connectionId), eq(gitConnections.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Connection not found");

    return {
      id: updated.id,
      provider: updated.provider,
      projectId: updated.projectId,
      repoUrl: updated.repoUrl,
      repoName: updated.repoName,
      isActive: updated.isActive,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  async deleteGitConnection(orgId: string, connectionId: number) {
    const [deleted] = await this.db
      .delete(gitConnections)
      .where(and(eq(gitConnections.id, connectionId), eq(gitConnections.orgId, orgId)))
      .returning({ id: gitConnections.id });

    if (!deleted) throw new NotFoundException("Connection not found");
    return { success: true };
  }

  async updateUserRole(u: CurrentUserContext, targetUserId: string, role: string) {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, targetUserId),
        eq(organizationMembers.orgId, u.orgId),
      ),
      columns: { id: true, isOwner: true },
    });
    if (!member) throw new NotFoundException("User not found in this organization");

    if (member.isOwner) {
      throw new BadRequestException(
        "The organization owner's role cannot be changed here. Use the ownership transfer flow instead.",
      );
    }

    await assertMayGrantRole(this.access, u.orgId, u, role);

    await this.db.transaction(async (tx) => {
      await tx
        .update(organizationMembers)
        .set({ role })
        .where(
          and(
            eq(organizationMembers.userId, targetUserId),
            eq(organizationMembers.orgId, u.orgId),
          ),
        );
      await syncStructuralRoleAssignment(tx, u.orgId, member.id, role);
    });

    await bustMembershipStatusCache(this.cache, targetUserId, u.orgId);

    return { success: true, userId: targetUserId, role };
  }
}
