import { Inject, Injectable, Logger, BadRequestException, type OnModuleInit } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { notificationEvents, notificationAuditLogs } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { NOTIF_CACHE } from "./notification-cache-keys";
import { NOTIFICATION_EVENT_CATALOG, NOTIFICATION_EVENT_MAP } from "./notification-events.catalog";
import { ALL_CHANNELS } from "./notification.types";
import type { NotificationChannel, NotificationEventDefinition, NotificationPriority, QuietHoursBehavior } from "./notification.types";

type EventRow = typeof notificationEvents.$inferSelect;

export interface EventPolicyPatch {
  enabled?: boolean;
  defaultPriority?: NotificationPriority;
  defaultChannels?: NotificationChannel[];
  allowedChannels?: NotificationChannel[];
  mandatory?: boolean;
  userConfigurable?: boolean;
  quietHoursBehavior?: QuietHoursBehavior;
  dedupeWindowSeconds?: number;
  rateLimitWindowSeconds?: number;
  rateLimitMax?: number;
}

@Injectable()
export class NotificationEventRegistryService implements OnModuleInit {
  private readonly logger = new Logger(NotificationEventRegistryService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  private loadOrgDefinitions(orgId: string): Promise<Record<string, { definition: NotificationEventDefinition; enabled: boolean }>> {
    return this.cache.cached(
      NOTIF_CACHE.events(orgId),
      async () => {
        const rows = await this.db.query.notificationEvents.findMany({
          where: eq(notificationEvents.orgId, orgId),
        });
        const map: Record<string, { definition: NotificationEventDefinition; enabled: boolean }> = {};
        for (const row of rows) {
          map[row.eventKey] = { definition: this.rowToDefinition(row, NOTIFICATION_EVENT_MAP.get(row.eventKey)), enabled: row.enabled };
        }
        return map;
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.seedGlobalCatalog();
    } catch (error) {
      this.logger.warn(`Notification event catalog seed skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async seedGlobalCatalog(): Promise<void> {
    const existing = await this.db
      .select({ eventKey: notificationEvents.eventKey })
      .from(notificationEvents)
      .where(isNull(notificationEvents.orgId));
    const known = new Set(existing.map((r) => r.eventKey));
    const missing = NOTIFICATION_EVENT_CATALOG.filter((d) => !known.has(d.eventKey));
    if (missing.length === 0) return;
    await this.db.insert(notificationEvents).values(
      missing.map((d) => ({
        orgId: null,
        eventKey: d.eventKey,
        sourceModule: d.sourceModule,
        category: d.category,
        displayName: d.displayName,
        description: d.description,
        defaultPriority: d.defaultPriority,
        defaultType: d.defaultType,
        defaultChannels: d.defaultChannels,
        allowedChannels: d.allowedChannels,
        mandatory: d.mandatory,
        userConfigurable: d.userConfigurable,
        adminConfigurable: d.adminConfigurable,
        quietHoursBehavior: d.quietHoursBehavior,
        dedupeWindowSeconds: d.dedupeWindowSeconds,
        rateLimitWindowSeconds: d.rateLimitWindowSeconds,
        rateLimitMax: d.rateLimitMax,
        templateKey: d.templateKey ?? null,
        audienceResolver: d.audienceResolver ?? null,
      })),
    );
    this.logger.log(`Seeded ${missing.length} global notification events`);
  }

  getBaseDefinition(eventKey: string): NotificationEventDefinition | undefined {
    return NOTIFICATION_EVENT_MAP.get(eventKey);
  }

  private rowToDefinition(row: EventRow, base?: NotificationEventDefinition): NotificationEventDefinition {
    return {
      eventKey: row.eventKey,
      sourceModule: row.sourceModule,
      category: row.category,
      displayName: row.displayName,
      description: row.description ?? row.displayName,
      defaultPriority: row.defaultPriority,
      defaultType: row.defaultType,
      defaultChannels: row.defaultChannels.filter((c): c is NotificationChannel => ALL_CHANNELS.includes(c as NotificationChannel)),
      allowedChannels: row.allowedChannels.filter((c): c is NotificationChannel => ALL_CHANNELS.includes(c as NotificationChannel)),
      mandatory: (base?.mandatory ?? false) || row.mandatory,
      userConfigurable: row.userConfigurable,
      adminConfigurable: row.adminConfigurable,
      quietHoursBehavior: row.quietHoursBehavior,
      dedupeWindowSeconds: row.dedupeWindowSeconds,
      rateLimitWindowSeconds: row.rateLimitWindowSeconds,
      rateLimitMax: row.rateLimitMax,
      templateKey: row.templateKey ?? undefined,
      audienceResolver: row.audienceResolver ?? undefined,
    };
  }

  async resolveDefinition(orgId: string, eventKey: string): Promise<{ definition: NotificationEventDefinition; enabled: boolean } | null> {
    const overrides = await this.loadOrgDefinitions(orgId);
    const override = overrides[eventKey];
    if (override) return override;
    const base = NOTIFICATION_EVENT_MAP.get(eventKey);
    if (base) return { definition: base, enabled: true };
    return null;
  }

  assertKnown(eventKey: string): NotificationEventDefinition {
    const base = NOTIFICATION_EVENT_MAP.get(eventKey);
    if (!base) throw new BadRequestException(`Unknown notification event: ${eventKey}`);
    return base;
  }

  async listForOrg(orgId: string): Promise<Array<NotificationEventDefinition & { enabled: boolean; overridden: boolean }>> {
    const overrides = await this.loadOrgDefinitions(orgId);
    return NOTIFICATION_EVENT_CATALOG.map((base) => {
      const o = overrides[base.eventKey];
      if (o) return { ...o.definition, enabled: o.enabled, overridden: true };
      return { ...base, enabled: true, overridden: false };
    });
  }

  async updateOrgEventPolicy(orgId: string, eventKey: string, patch: EventPolicyPatch, actorId?: string): Promise<NotificationEventDefinition & { enabled: boolean }> {
    const base = this.assertKnown(eventKey);
    if (base.mandatory && patch.enabled === false) {
      throw new BadRequestException("Mandatory events cannot be disabled");
    }
    if (base.mandatory && patch.mandatory === false) {
      throw new BadRequestException("Mandatory events cannot be made optional");
    }
    const existing = await this.db.query.notificationEvents.findFirst({
      where: and(eq(notificationEvents.orgId, orgId), eq(notificationEvents.eventKey, eventKey)),
    });

    const merged = {
      orgId,
      eventKey: base.eventKey,
      sourceModule: base.sourceModule,
      category: base.category,
      displayName: base.displayName,
      description: base.description,
      defaultPriority: patch.defaultPriority ?? existing?.defaultPriority ?? base.defaultPriority,
      defaultType: base.defaultType,
      defaultChannels: patch.defaultChannels ?? (existing ? existing.defaultChannels.filter((c): c is NotificationChannel => ALL_CHANNELS.includes(c as NotificationChannel)) : undefined) ?? base.defaultChannels,
      allowedChannels: patch.allowedChannels ?? (existing ? existing.allowedChannels.filter((c): c is NotificationChannel => ALL_CHANNELS.includes(c as NotificationChannel)) : undefined) ?? base.allowedChannels,
      mandatory: base.mandatory || (patch.mandatory ?? existing?.mandatory ?? false),
      userConfigurable: patch.userConfigurable ?? existing?.userConfigurable ?? base.userConfigurable,
      adminConfigurable: base.adminConfigurable,
      quietHoursBehavior: patch.quietHoursBehavior ?? existing?.quietHoursBehavior ?? base.quietHoursBehavior,
      dedupeWindowSeconds: patch.dedupeWindowSeconds ?? existing?.dedupeWindowSeconds ?? base.dedupeWindowSeconds,
      rateLimitWindowSeconds: patch.rateLimitWindowSeconds ?? existing?.rateLimitWindowSeconds ?? base.rateLimitWindowSeconds,
      rateLimitMax: patch.rateLimitMax ?? existing?.rateLimitMax ?? base.rateLimitMax,
      templateKey: base.templateKey ?? null,
      audienceResolver: base.audienceResolver ?? null,
      enabled: patch.enabled ?? existing?.enabled ?? true,
    };

    if (existing) {
      await this.db.update(notificationEvents).set(merged).where(eq(notificationEvents.id, existing.id));
    } else {
      await this.db.insert(notificationEvents).values(merged);
    }
    await this.db.insert(notificationAuditLogs).values({
      orgId,
      actorId: actorId ?? null,
      action: "event_policy.updated",
      sourceModule: base.sourceModule,
      metadata: { entityType: "event", eventKey, patch },
    });
    await this.cache.del(NOTIF_CACHE.events(orgId));

    const resolved = await this.resolveDefinition(orgId, eventKey);
    return { ...(resolved?.definition ?? base), enabled: merged.enabled };
  }
}
