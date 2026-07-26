import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { eq, and } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { InventoryAuditService } from "../inv-stock-engine/inventory-audit.service";
import { inv3plConnections } from "../../db/schema";
import type { Create3plConnectionInput, Update3plConnectionInput } from "./dto/channels.schemas";

@Injectable()
export class TplService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: InventoryAuditService,
  ) {}

  listConnections(orgId: string, page = 1, limit = 100) {
    const safeLimit = Math.min(limit, 100);
    const offset = (page - 1) * safeLimit;
    return this.cache.cached(
      CACHE_KEYS.inv3plList(orgId),
      () =>
        this.db.query.inv3plConnections.findMany({
          where: eq(inv3plConnections.orgId, orgId),
          orderBy: (t, { asc }) => [asc(t.name)],
          limit: safeLimit,
          offset,
        }),
      CACHE_TTL.MEDIUM,
    );
  }

  async createConnection(orgId: string, userId: string, input: Create3plConnectionInput) {
    const [connection] = await this.db
      .insert(inv3plConnections)
      .values({ orgId, status: "DISCONNECTED", ...input })
      .returning();

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "3pl.connection.created",
      resourceType: "inv_3pl_connection",
      resourceId: String(connection.id),
      after: connection,
    });

    await this.cache.invalidate(CACHE_KEYS.inv3plList(orgId));
    return connection;
  }

  async updateConnection(
    orgId: string,
    userId: string,
    connectionId: number,
    input: Update3plConnectionInput,
  ) {
    const existing = await this.db.query.inv3plConnections.findFirst({
      where: and(eq(inv3plConnections.id, connectionId), eq(inv3plConnections.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("3PL connection not found");

    const [updated] = await this.db
      .update(inv3plConnections)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(inv3plConnections.id, connectionId), eq(inv3plConnections.orgId, orgId)))
      .returning();

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "3pl.connection.updated",
      resourceType: "inv_3pl_connection",
      resourceId: String(connectionId),
      before: existing,
      after: updated,
    });

    await this.cache.invalidate(CACHE_KEYS.inv3plList(orgId));
    return updated;
  }

  async syncConnection(orgId: string, userId: string, connectionId: number) {
    const existing = await this.db.query.inv3plConnections.findFirst({
      where: and(eq(inv3plConnections.id, connectionId), eq(inv3plConnections.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("3PL connection not found");

    await this.db
      .update(inv3plConnections)
      .set({
        lastSyncAt: new Date(),
        lastSyncStatus: "ERROR: Provider not connected",
        updatedAt: new Date(),
      })
      .where(and(eq(inv3plConnections.id, connectionId), eq(inv3plConnections.orgId, orgId)));

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "3pl.connection.synced",
      resourceType: "inv_3pl_connection",
      resourceId: String(connectionId),
    });

    await this.cache.invalidate(CACHE_KEYS.inv3plList(orgId));
    return { connectionId, status: "ERROR", message: "Provider not connected" };
  }
}
