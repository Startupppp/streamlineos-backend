import { Injectable, Inject, NotFoundException, ConflictException } from "@nestjs/common";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import {
  invChannels,
  invChannelStockPublications,
  invStockLevels,
  invLocations,
} from "../../../db/schema";
import type {
  CreateChannelInput,
  UpdateChannelInput,
  ListPublicationsQueryInput,
  RetryPublicationsInput,
} from "./dto/channels.schemas";

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as Record<string, unknown>)["code"] === "23505"
  );
}

@Injectable()
export class ChannelsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: InventoryAuditService,
  ) {}

  list(orgId: string, page = 1, limit = 100) {
    const safeLimit = Math.min(limit, 100);
    const offset = (page - 1) * safeLimit;
    return this.cache.cached(
      CACHE_KEYS.invChannelsList(orgId),
      () =>
        this.db.query.invChannels.findMany({
          where: eq(invChannels.orgId, orgId),
          orderBy: (t, { asc }) => [asc(t.name)],
          limit: safeLimit,
          offset,
        }),
      CACHE_TTL.MEDIUM,
    );
  }

  async findOne(orgId: string, channelId: number) {
    return this.cache.cached(
      CACHE_KEYS.invChannelDetail(orgId, channelId),
      async () => {
        const channel = await this.db.query.invChannels.findFirst({
          where: and(eq(invChannels.id, channelId), eq(invChannels.orgId, orgId)),
        });
        if (!channel) throw new NotFoundException("Channel not found");
        return channel;
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async create(orgId: string, userId: string, input: CreateChannelInput) {
    let channel: typeof invChannels.$inferSelect;
    try {
      const [created] = await this.db
        .insert(invChannels)
        .values({ orgId, ...input })
        .returning();
      channel = created;
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException("A channel with this name already exists");
      }
      throw e;
    }

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "channel.created",
      resourceType: "inv_channel",
      resourceId: String(channel.id),
      after: channel,
    });

    await this.cache.invalidate(CACHE_KEYS.invChannelsList(orgId));
    return channel;
  }

  async update(orgId: string, userId: string, channelId: number, input: UpdateChannelInput) {
    const existing = await this.db.query.invChannels.findFirst({
      where: and(eq(invChannels.id, channelId), eq(invChannels.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Channel not found");

    let updated: typeof invChannels.$inferSelect;
    try {
      const [result] = await this.db
        .update(invChannels)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(invChannels.id, channelId), eq(invChannels.orgId, orgId)))
        .returning();
      updated = result;
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException("A channel with this name already exists");
      }
      throw e;
    }

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "channel.updated",
      resourceType: "inv_channel",
      resourceId: String(channelId),
      before: existing,
      after: updated,
    });

    await Promise.all([
      this.cache.invalidate(CACHE_KEYS.invChannelDetail(orgId, channelId)),
      this.cache.invalidate(CACHE_KEYS.invChannelsList(orgId)),
    ]);

    return updated;
  }

  async syncStock(orgId: string, userId: string, channelId: number) {
    const channel = await this.db.query.invChannels.findFirst({
      where: and(eq(invChannels.id, channelId), eq(invChannels.orgId, orgId)),
    });
    if (!channel) throw new NotFoundException("Channel not found");

    if (channel.status === "PAUSED") return { synced: 0, skipped: 0 };

    const warehouseIds = (channel.warehouseIds ?? []) as number[];

    const locations =
      warehouseIds.length > 0
        ? await this.db
            .select({ id: invLocations.id })
            .from(invLocations)
            .where(
              and(
                eq(invLocations.orgId, orgId),
                inArray(invLocations.warehouseId, warehouseIds),
              ),
            )
        : [];

    const locationIds = locations.map((l) => l.id);

    const stockRows =
      locationIds.length > 0
        ? await this.db
            .select({
              productVariantId: invStockLevels.productVariantId,
              onHand: invStockLevels.onHand,
              committed: invStockLevels.committed,
              blockedQty: invStockLevels.blockedQty,
              qualityHoldQty: invStockLevels.qualityHoldQty,
            })
            .from(invStockLevels)
            .where(
              and(
                eq(invStockLevels.orgId, orgId),
                inArray(invStockLevels.locationId, locationIds),
              ),
            )
        : [];

    const variantMap = new Map<
      number,
      { onHand: number; committed: number; blocked: number; qualityHold: number }
    >();

    for (const row of stockRows) {
      const prev = variantMap.get(row.productVariantId) ?? {
        onHand: 0,
        committed: 0,
        blocked: 0,
        qualityHold: 0,
      };
      variantMap.set(row.productVariantId, {
        onHand: prev.onHand + parseFloat(row.onHand ?? "0"),
        committed: prev.committed + parseFloat(row.committed ?? "0"),
        blocked: prev.blocked + parseFloat(row.blockedQty ?? "0"),
        qualityHold: prev.qualityHold + parseFloat(row.qualityHoldQty ?? "0"),
      });
    }

    const safetyBuffer = parseFloat(channel.safetyBuffer ?? "0");
    const publishThreshold = parseFloat(channel.publishThreshold ?? "0");
    const isInternal = channel.channelType === "INTERNAL";
    const pubStatus = isInternal ? ("PUBLISHED" as const) : ("FAILED" as const);
    const pubError = isInternal ? null : "Provider not connected";
    const pubAt = isInternal ? new Date() : null;
    const now = new Date();

    let synced = 0;
    let skipped = 0;

    const rows: Array<typeof invChannelStockPublications.$inferInsert> = [];
    for (const [productVariantId, totals] of variantMap.entries()) {
      const available =
        totals.onHand - totals.committed - totals.blocked - totals.qualityHold;
      const publishable = Math.max(0, available - safetyBuffer);

      if (publishable < publishThreshold) {
        skipped++;
        continue;
      }

      rows.push({
        orgId,
        channelId,
        productVariantId,
        publishedQty: publishable.toFixed(4),
        availableQty: available.toFixed(4),
        status: pubStatus,
        error: pubError,
        publishedAt: pubAt,
      });
      synced++;
    }

    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await this.db
        .insert(invChannelStockPublications)
        .values(chunk)
        .onConflictDoUpdate({
          target: [
            invChannelStockPublications.orgId,
            invChannelStockPublications.channelId,
            invChannelStockPublications.productVariantId,
          ],
          set: {
            publishedQty: sql`excluded.published_qty`,
            availableQty: sql`excluded.available_qty`,
            status: sql`excluded.status`,
            error: sql`excluded.error`,
            publishedAt: sql`excluded.published_at`,
            updatedAt: now,
          },
        });
    }

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "channel.stock_synced",
      resourceType: "inv_channel",
      resourceId: String(channelId),
      metadata: { synced, skipped },
    });

    await this.cache.invalidate(CACHE_KEYS.invChannelDetail(orgId, channelId));
    return { synced, skipped };
  }

  async listPublications(orgId: string, channelId: number, query: ListPublicationsQueryInput) {
    const channel = await this.db.query.invChannels.findFirst({
      where: and(eq(invChannels.id, channelId), eq(invChannels.orgId, orgId)),
      columns: { id: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");

    const offset = (query.page - 1) * query.limit;

    const conditions = [
      eq(invChannelStockPublications.orgId, orgId),
      eq(invChannelStockPublications.channelId, channelId),
      ...(query.status ? [eq(invChannelStockPublications.status, query.status)] : []),
    ];

    const [items, [countRow]] = await Promise.all([
      this.db
        .select()
        .from(invChannelStockPublications)
        .where(and(...conditions))
        .orderBy(desc(invChannelStockPublications.updatedAt))
        .limit(query.limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invChannelStockPublications)
        .where(and(...conditions)),
    ]);

    const total = countRow?.count ?? 0;
    return {
      items,
      total,
      page: query.page,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async retryPublications(
    orgId: string,
    userId: string,
    channelId: number,
    input: RetryPublicationsInput,
  ) {
    const channel = await this.db.query.invChannels.findFirst({
      where: and(eq(invChannels.id, channelId), eq(invChannels.orgId, orgId)),
    });
    if (!channel) throw new NotFoundException("Channel not found");

    const failedConditions = [
      eq(invChannelStockPublications.orgId, orgId),
      eq(invChannelStockPublications.channelId, channelId),
      eq(invChannelStockPublications.status, "FAILED"),
      ...(input.productVariantIds?.length
        ? [inArray(invChannelStockPublications.productVariantId, input.productVariantIds)]
        : []),
    ];

    const failedPubs = await this.db
      .select({ productVariantId: invChannelStockPublications.productVariantId })
      .from(invChannelStockPublications)
      .where(and(...failedConditions));

    if (failedPubs.length === 0) return { retried: 0 };

    const variantIds = failedPubs.map((r) => r.productVariantId);

    const warehouseIds = (channel.warehouseIds ?? []) as number[];

    const locations =
      warehouseIds.length > 0
        ? await this.db
            .select({ id: invLocations.id })
            .from(invLocations)
            .where(
              and(
                eq(invLocations.orgId, orgId),
                inArray(invLocations.warehouseId, warehouseIds),
              ),
            )
        : [];

    const locationIds = locations.map((l) => l.id);

    const stockRows =
      locationIds.length > 0
        ? await this.db
            .select({
              productVariantId: invStockLevels.productVariantId,
              onHand: invStockLevels.onHand,
              committed: invStockLevels.committed,
              blockedQty: invStockLevels.blockedQty,
              qualityHoldQty: invStockLevels.qualityHoldQty,
            })
            .from(invStockLevels)
            .where(
              and(
                eq(invStockLevels.orgId, orgId),
                inArray(invStockLevels.locationId, locationIds),
                inArray(invStockLevels.productVariantId, variantIds),
              ),
            )
        : [];

    const variantMap = new Map<
      number,
      { onHand: number; committed: number; blocked: number; qualityHold: number }
    >();

    for (const row of stockRows) {
      const prev = variantMap.get(row.productVariantId) ?? {
        onHand: 0,
        committed: 0,
        blocked: 0,
        qualityHold: 0,
      };
      variantMap.set(row.productVariantId, {
        onHand: prev.onHand + parseFloat(row.onHand ?? "0"),
        committed: prev.committed + parseFloat(row.committed ?? "0"),
        blocked: prev.blocked + parseFloat(row.blockedQty ?? "0"),
        qualityHold: prev.qualityHold + parseFloat(row.qualityHoldQty ?? "0"),
      });
    }

    const safetyBuffer = parseFloat(channel.safetyBuffer ?? "0");
    const isInternal = channel.channelType === "INTERNAL";
    const pubStatus = isInternal ? ("PUBLISHED" as const) : ("FAILED" as const);
    const pubError = isInternal ? null : "Provider not connected";
    const pubAt = isInternal ? new Date() : null;
    const now = new Date();

    const retryRows: Array<typeof invChannelStockPublications.$inferInsert> = [];
    for (const productVariantId of variantIds) {
      const totals = variantMap.get(productVariantId) ?? {
        onHand: 0,
        committed: 0,
        blocked: 0,
        qualityHold: 0,
      };
      const available =
        totals.onHand - totals.committed - totals.blocked - totals.qualityHold;
      const publishable = Math.max(0, available - safetyBuffer);

      retryRows.push({
        orgId,
        channelId,
        productVariantId,
        publishedQty: publishable.toFixed(4),
        availableQty: available.toFixed(4),
        status: pubStatus,
        error: pubError,
        publishedAt: pubAt,
      });
    }

    const CHUNK = 500;
    for (let i = 0; i < retryRows.length; i += CHUNK) {
      const chunk = retryRows.slice(i, i + CHUNK);
      await this.db
        .insert(invChannelStockPublications)
        .values(chunk)
        .onConflictDoUpdate({
          target: [
            invChannelStockPublications.orgId,
            invChannelStockPublications.channelId,
            invChannelStockPublications.productVariantId,
          ],
          set: {
            publishedQty: sql`excluded.published_qty`,
            availableQty: sql`excluded.available_qty`,
            status: sql`excluded.status`,
            error: sql`excluded.error`,
            publishedAt: sql`excluded.published_at`,
            updatedAt: now,
          },
        });
    }

    const retried = retryRows.length;

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "channel.publications_retried",
      resourceType: "inv_channel",
      resourceId: String(channelId),
      metadata: { retried },
    });

    return { retried };
  }
}
