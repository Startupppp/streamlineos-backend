import { Injectable, Inject, NotFoundException, ConflictException } from "@nestjs/common";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { ChannelPoolService } from "../stock-engine/channel-pool.service";
import {
  invChannels,
  invChannelStockPublications,
  invStockLevels,
  invLocations,
} from "../../../db/schema";
import { availableQtySumSql } from "../stock-engine/available-sql";
import { subDec, cmpDec, isNegative } from "../stock-engine/decimal";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import { encryptSecret, maskSecretHint } from "../../../common/security/secret-encryption.util";
import type {
  CreateChannelInput,
  UpdateChannelInput,
  ListPublicationsQueryInput,
  RetryPublicationsInput,
} from "./dto/channels.schemas";

function sanitizeChannelRow<T extends Record<string, unknown>>(row: T) {
  const { apiCredentialEncrypted, webhookSecretEncrypted, ...safe } = row;
  return safe;
}

@Injectable()
export class ChannelsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: InventoryAuditService,
    private readonly channelPools: ChannelPoolService,
  ) {}

  async list(orgId: string, page = 1, limit = 100) {
    const safeLimit = Math.min(limit, 100);
    const offset = (page - 1) * safeLimit;
    const rows = await this.cache.cached(
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
    return rows.map(sanitizeChannelRow);
  }

  async findOne(orgId: string, channelId: number) {
    return this.cache.cached(
      CACHE_KEYS.invChannelDetail(orgId, channelId),
      async () => {
        const channel = await this.db.query.invChannels.findFirst({
          where: and(eq(invChannels.id, channelId), eq(invChannels.orgId, orgId)),
        });
        if (!channel) throw new NotFoundException("Channel not found");
        return sanitizeChannelRow(channel);
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async create(orgId: string, userId: string, input: CreateChannelInput) {
    const { apiCredential, webhookSecret, ...rest } = input;
    const apiCredentialEncrypted = apiCredential ? encryptSecret(apiCredential) : null;
    const apiCredentialHint = apiCredential ? maskSecretHint(apiCredential) : null;
    const webhookSecretEncrypted = webhookSecret ? encryptSecret(webhookSecret) : null;

    let channel: typeof invChannels.$inferSelect;
    try {
      const [created] = await this.db
        .insert(invChannels)
        .values({
          orgId,
          ...rest,
          apiCredentialEncrypted,
          apiCredentialHint,
          webhookSecretEncrypted,
        })
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
    return sanitizeChannelRow(channel);
  }

  async update(orgId: string, userId: string, channelId: number, input: UpdateChannelInput) {
    const existing = await this.db.query.invChannels.findFirst({
      where: and(eq(invChannels.id, channelId), eq(invChannels.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Channel not found");

    const { apiCredential, webhookSecret, ...rest } = input;
    const patch: Record<string, unknown> = { ...rest, updatedAt: new Date() };

    if (apiCredential !== undefined) {
      patch.apiCredentialEncrypted = apiCredential ? encryptSecret(apiCredential) : null;
      patch.apiCredentialHint = apiCredential ? maskSecretHint(apiCredential) : null;
    }
    if (webhookSecret !== undefined) {
      patch.webhookSecretEncrypted = webhookSecret ? encryptSecret(webhookSecret) : null;
    }

    let updated: typeof invChannels.$inferSelect;
    try {
      const [result] = await this.db
        .update(invChannels)
        .set(patch)
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

    return sanitizeChannelRow(updated);
  }


  async syncStock(orgId: string, userId: string, channelId: number) {
    const channel = await this.db.query.invChannels.findFirst({
      where: and(eq(invChannels.id, channelId), eq(invChannels.orgId, orgId)),
    });
    if (!channel) throw new NotFoundException("Channel not found");

    if (channel.status === "PAUSED") return { synced: 0, skipped: 0 };

    const warehouseIds = channel.warehouseIds ?? [];

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

    // A1/A2. What a marketplace is told is for sale is availability, and this
    // had its own four-term copy in floats: it dropped `outgoing_qty`, so units
    // already picked into a tote were offered again, and it summed across
    // locations *before* subtracting, which makes the non-sellable gate
    // impossible to apply at all — stock sitting at a TRANSIT location while it
    // was on a lorry was published as buyable.
    //
    // Summed in the database by the one shared expression, which applies the
    // sellable gate per row before aggregating, and returned as text so no
    // ledger quantity passes through a float on its way to a customer.
    const stockRows =
      locationIds.length > 0
        ? await this.db.execute<{ product_variant_id: number; available: string }>(sql`
            SELECT inv_stock_levels.product_variant_id,
                   ${availableQtySumSql("inv_stock_levels")}::text AS available
              FROM inv_stock_levels
             WHERE inv_stock_levels.org_id = ${orgId}
               AND inv_stock_levels.location_id IN (${sql.join(
                 locationIds.map((id) => sql`${id}`),
                 sql`, `,
               )})
             GROUP BY inv_stock_levels.product_variant_id
          `)
        : [];

    const variantMap = new Map<number, string>();
    for (const row of stockRows) {
      variantMap.set(Number(row.product_variant_id), String(row.available));
    }

    const safetyBuffer = channel.safetyBuffer ?? "0";
    const publishThreshold = channel.publishThreshold ?? "0";
    const isInternal = channel.channelType === "INTERNAL";
    const pubStatus = isInternal ? ("PUBLISHED" as const) : ("FAILED" as const);
    const pubError = isInternal ? null : "Provider not connected";
    const pubAt = isInternal ? new Date() : null;
    const now = new Date();

    let synced = 0;
    let skipped = 0;

    const rows: Array<typeof invChannelStockPublications.$inferInsert> = [];
    // Kept beside `rows` rather than derived from it: `$inferInsert` types
    // `publishedQty` as optional because the column has a default, so mapping it
    // back out yields `string | undefined` for a value that is always set here.
    const poolRows: Array<{ channelId: number; productVariantId: number; publishedQty: string }> = [];
    for (const [productVariantId, available] of variantMap.entries()) {
      const afterBuffer = subDec(available, safetyBuffer);
      const publishable = isNegative(afterBuffer) ? "0.0000" : afterBuffer;

      if (cmpDec(publishable, publishThreshold) < 0) {
        skipped++;
        continue;
      }

      rows.push({
        orgId,
        channelId,
        productVariantId,
        publishedQty: publishable,
        availableQty: available,
        status: pubStatus,
        error: pubError,
        publishedAt: pubAt,
      });
      poolRows.push({ channelId, productVariantId, publishedQty: publishable });
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

    // The pool row carries `published_qty` — "what this channel was last told" —
    // and until now NOTHING wrote it. `listForChannel`, `listForVariant` and the
    // allocate result all select that column, and the controller serves the first
    // two, so every caller was reading the DEFAULT '0' forever while the real
    // figure sat in `inv_channel_stock_publications`. Written here because this is
    // the moment the channel is told.
    //
    // Only on a real publish: `pubStatus` is FAILED for any non-INTERNAL channel
    // ("Provider not connected"), and a channel that was told nothing has no last
    // told figure. Upserting cannot disturb promises — `hasAnyPool` gates on
    // `reserved_qty > 0`, and this writes `published_qty` only.
    if (pubStatus === "PUBLISHED" && poolRows.length > 0) {
      await this.channelPools.recordPublishedInTx(this.db, orgId, poolRows);
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

    const warehouseIds = channel.warehouseIds ?? [];

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
        ? await this.db.execute<{ product_variant_id: number; available: string }>(sql`
            SELECT inv_stock_levels.product_variant_id,
                   ${availableQtySumSql("inv_stock_levels")}::text AS available
              FROM inv_stock_levels
             WHERE inv_stock_levels.org_id = ${orgId}
               AND inv_stock_levels.location_id IN (${sql.join(
                 locationIds.map((id) => sql`${id}`),
                 sql`, `,
               )})
               AND inv_stock_levels.product_variant_id IN (${sql.join(
                 variantIds.map((id) => sql`${id}`),
                 sql`, `,
               )})
             GROUP BY inv_stock_levels.product_variant_id
          `)
        : [];

    // The retry path published the same wrong number as the sync path, in its
    // own copy. One expression now serves both.
    const variantMap = new Map<number, string>();
    for (const row of stockRows) {
      variantMap.set(Number(row.product_variant_id), String(row.available));
    }

    const safetyBuffer = channel.safetyBuffer ?? "0";
    const isInternal = channel.channelType === "INTERNAL";
    const pubStatus = isInternal ? ("PUBLISHED" as const) : ("FAILED" as const);
    const pubError = isInternal ? null : "Provider not connected";
    const pubAt = isInternal ? new Date() : null;
    const now = new Date();

    const retryRows: Array<typeof invChannelStockPublications.$inferInsert> = [];
    for (const productVariantId of variantIds) {
      const available = variantMap.get(productVariantId) ?? "0.0000";
      const afterBuffer = subDec(available, safetyBuffer);
      const publishable = isNegative(afterBuffer) ? "0.0000" : afterBuffer;

      retryRows.push({
        orgId,
        channelId,
        productVariantId,
        publishedQty: publishable,
        availableQty: available,
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
