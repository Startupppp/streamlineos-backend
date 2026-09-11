import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invCarriers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import type { CreateCarrierInput, UpdateCarrierInput } from "./dto/shipments.schemas";

/**
 * Every column a carrier read may return — and, by its absence, every column it
 * may not.
 *
 * INV-26 put two ciphertext columns on this table (`api_credential_encrypted`,
 * `webhook_secret_encrypted`). The three reads below used a bare `.select()`
 * and `.returning()`, which is `SELECT *`: adding the columns would have handed
 * every tenant's courier ciphertext to the carrier list, the create response
 * and the update response on the same day, with nothing saying so. One
 * projection, named once, is what makes that impossible rather than unlikely —
 * a future column is out until somebody adds it here deliberately.
 *
 * `webhookSecretSet` is derived rather than selected for the same reason: an
 * administrator needs to know whether a secret is installed, and that question
 * is answerable without the value.
 */
const CARRIER_COLUMNS = {
  id: invCarriers.id,
  orgId: invCarriers.orgId,
  name: invCarriers.name,
  code: invCarriers.code,
  trackingUrlTemplate: invCarriers.trackingUrlTemplate,
  isActive: invCarriers.isActive,
  transport: invCarriers.transport,
  apiBaseUrl: invCarriers.apiBaseUrl,
  /** "****3f9a" — never enough to reconstruct the key. */
  apiCredentialHint: invCarriers.apiCredentialHint,
  webhookSecretSet: sql<boolean>`${invCarriers.webhookSecretEncrypted} IS NOT NULL`,
  webhookLastFailureAt: invCarriers.webhookLastFailureAt,
  webhookFailureReason: invCarriers.webhookFailureReason,
  createdAt: invCarriers.createdAt,
  updatedAt: invCarriers.updatedAt,
} as const;

@Injectable()
export class CarriersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: InventoryAuditService,
  ) {}

  list(orgId: string, page = 1, limit = 100) {
    const cappedLimit = Math.min(limit, 100);
    const offset = (page - 1) * cappedLimit;
    const cacheKey = `${cappedLimit}:${offset}`;
    return this.cache.cachedVersioned(
      CACHE_KEYS.invCarriersNamespace(orgId),
      cacheKey,
      () =>
        this.db
          .select(CARRIER_COLUMNS)
          .from(invCarriers)
          .where(eq(invCarriers.orgId, orgId))
          .orderBy(invCarriers.name)
          .limit(cappedLimit)
          .offset(offset),
      CACHE_TTL.MEDIUM,
    );
  }

  async create(orgId: string, userId: string, input: CreateCarrierInput) {
    const [carrier] = await this.db.transaction(async (tx) => {
      const rows = await tx.insert(invCarriers).values({ ...input, orgId }).returning(CARRIER_COLUMNS);
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "carrier.created",
        resourceType: "carrier",
        resourceId: String(rows[0]!.id),
      });
      return rows;
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invCarriersNamespace(orgId));
    return carrier;
  }

  async update(orgId: string, userId: string, carrierId: number, input: UpdateCarrierInput) {
    const [existing] = await this.db
      .select(CARRIER_COLUMNS)
      .from(invCarriers)
      .where(and(eq(invCarriers.id, carrierId), eq(invCarriers.orgId, orgId)))
      .limit(1);
    if (!existing) throw new NotFoundException("Carrier not found");

    const [updated] = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(invCarriers)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(invCarriers.id, carrierId), eq(invCarriers.orgId, orgId)))
        .returning(CARRIER_COLUMNS);
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "carrier.updated",
        resourceType: "carrier",
        resourceId: String(carrierId),
        before: existing,
        after: rows[0],
      });
      return rows;
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invCarriersNamespace(orgId));
    return updated;
  }
}
