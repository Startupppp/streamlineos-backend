import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { featureFlags, type OrgOverride } from "../../db/schema/feature-flags";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import type { CreateFlagInput, UpdateFlagInput } from "./dto/feature-flag.schemas";

const FLAGS_TTL = 60;

@Injectable()
export class FeatureFlagsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async list(filters?: { includeArchived?: boolean }) {
    type FlagRow = typeof featureFlags.$inferSelect;
    return this.cache.cached<FlagRow[]>(
      CACHE_KEYS.featureFlags(),
      () =>
        this.db.query.featureFlags.findMany({
          where: filters?.includeArchived ? undefined : eq(featureFlags.isArchived, false),
          orderBy: (t, { desc }) => [desc(t.createdAt)],
        }),
      FLAGS_TTL,
    );
  }

  async get(key: string) {
    const row = await this.db.query.featureFlags.findFirst({
      where: and(eq(featureFlags.key, key), eq(featureFlags.isArchived, false)),
    });
    if (!row) throw new NotFoundException(`Feature flag '${key}' not found`);
    return row;
  }

  async evaluate(key: string, orgId?: string): Promise<boolean> {
    type FlagRow = typeof featureFlags.$inferSelect;
    const allFlags = await this.list();
    const flag = allFlags.find((f: FlagRow) => f.key === key);
    if (!flag || flag.isArchived) return false;
    if (flag.expiresAt && flag.expiresAt < new Date()) return false;

    if (orgId) {
      const override = flag.orgOverrides.find((o: OrgOverride) => o.orgId === orgId);
      if (override !== undefined) return override.enabled;
    }

    if (flag.type === "percentage") {
      return flag.rolloutPercentage >= 100;
    }

    return flag.enabled;
  }

  async create(input: CreateFlagInput, userId: string) {
    const existing = await this.db.query.featureFlags.findFirst({
      where: eq(featureFlags.key, input.key),
    });
    if (existing) throw new ConflictException(`Feature flag with key '${input.key}' already exists`);

    const id = randomUUID();
    await this.db.insert(featureFlags).values({
      id,
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      type: input.type,
      enabled: input.enabled ?? false,
      rolloutPercentage: input.rolloutPercentage ?? 0,
      orgOverrides: [],
      expiresAt: input.expiresAt ?? null,
      isArchived: false,
      createdById: userId,
      updatedById: userId,
    });

    await this.invalidateCache();

    this.audit.log({
      action: "feature_flag.created",
      userId,
      metadata: { key: input.key, name: input.name },
    });

    return { id };
  }

  async update(key: string, input: UpdateFlagInput, userId: string) {
    const flag = await this.get(key);

    await this.db
      .update(featureFlags)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...(input.rolloutPercentage !== undefined && { rolloutPercentage: input.rolloutPercentage }),
        ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
        updatedById: userId,
        updatedAt: new Date(),
      })
      .where(eq(featureFlags.id, flag.id));

    await this.invalidateCache();

    this.audit.log({
      action: "feature_flag.updated",
      userId,
      metadata: { key, changes: input },
    });
  }

  async archive(key: string, userId: string) {
    const flag = await this.get(key);

    await this.db
      .update(featureFlags)
      .set({ isArchived: true, updatedById: userId, updatedAt: new Date() })
      .where(eq(featureFlags.id, flag.id));

    await this.invalidateCache();

    this.audit.log({
      action: "feature_flag.archived",
      userId,
      metadata: { key },
    });
  }

  async setOrgOverride(key: string, orgId: string, enabled: boolean, userId: string) {
    const flag = await this.get(key);
    const overrides: OrgOverride[] = flag.orgOverrides.filter((o: OrgOverride) => o.orgId !== orgId);
    overrides.push({ orgId, enabled });

    await this.db
      .update(featureFlags)
      .set({ orgOverrides: overrides, updatedById: userId, updatedAt: new Date() })
      .where(eq(featureFlags.id, flag.id));

    await this.invalidateCache();

    this.audit.log({
      action: "feature_flag.org_override_set",
      userId,
      metadata: { key, orgId, enabled },
    });
  }

  async removeOrgOverride(key: string, orgId: string, userId: string) {
    const flag = await this.get(key);
    const overrides = flag.orgOverrides.filter((o: OrgOverride) => o.orgId !== orgId);

    await this.db
      .update(featureFlags)
      .set({ orgOverrides: overrides, updatedById: userId, updatedAt: new Date() })
      .where(eq(featureFlags.id, flag.id));

    await this.invalidateCache();

    this.audit.log({
      action: "feature_flag.org_override_removed",
      userId,
      metadata: { key, orgId },
    });
  }

  private async invalidateCache() {
    await Promise.all([
      this.cache.invalidate(CACHE_KEYS.featureFlags()),
    ]);
  }
}
