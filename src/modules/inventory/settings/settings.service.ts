import { BadRequestException, Injectable, Inject, NotFoundException } from "@nestjs/common";
import { logger } from "../../../common/logger/logger.service";
import { eq, and, sql, lt, isNotNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { ReservationService } from "../stock-engine/reservation.service";
import {
  invNumberSequences,
  invStockLevels,
  invStockTransactions,
  invStockReservations,
  invImportJobs,
  invExportJobs,
  invWebhookEvents,
  invChannelStockPublications,
} from "../../../db/schema";
import type { UpdateSettingsInput, UpdateNumberSequenceInput } from "./dto/settings.schemas";

@Injectable()
export class SettingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly invSettings: InventorySettingsService,
    private readonly numSeq: NumberSequenceService,
    private readonly reservation: ReservationService,
    private readonly audit: InventoryAuditService,
    private readonly cache: CacheService,
  ) {}

  getSettings(orgId: string) {
    return this.invSettings.get(orgId);
  }

  async updateSettings(orgId: string, userId: string, input: UpdateSettingsInput) {
    const updated = await this.invSettings.update(orgId, input, userId);
    await this.cache.invalidate(CACHE_KEYS.invSettings(orgId));
    return updated;
  }

  async listNumberSequences(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.invNumberSequences(orgId),
      async () => {
        const dbRows = await this.db
          .select()
          .from(invNumberSequences)
          .where(eq(invNumberSequences.orgId, orgId));

        const docTypes = this.numSeq.getDocTypes();
        const rowsByDocType = new Map(dbRows.map(row => [row.docType, row]));

        return docTypes.map(docType => {
          const row = rowsByDocType.get(docType);
          if (row) return { ...row, isDefault: false };
          return { docType, prefix: docType.slice(0, 3), nextNumber: 1, padding: 5, isDefault: true };
        });
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async updateNumberSequence(
    orgId: string,
    userId: string,
    sequenceId: number,
    input: UpdateNumberSequenceInput,
  ) {
    const [sequence] = await this.db
      .select()
      .from(invNumberSequences)
      .where(and(eq(invNumberSequences.id, sequenceId), eq(invNumberSequences.orgId, orgId)));

    if (!sequence) throw new NotFoundException("Number sequence not found");

    if (input.nextNumber !== undefined && input.nextNumber < sequence.nextNumber) {
      throw new BadRequestException("nextNumber may only increase");
    }

    const [updated] = await this.db
      .update(invNumberSequences)
      .set(input)
      .where(and(eq(invNumberSequences.id, sequenceId), eq(invNumberSequences.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Number sequence not found after update");

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "number_sequence.updated",
      resourceType: "number_sequence",
      resourceId: String(sequenceId),
      before: sequence,
      after: updated,
    });

    await this.cache.invalidate(CACHE_KEYS.invNumberSequences(orgId));
    return updated;
  }

  async getHealth(orgId: string) {
    const reservationQuery = this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(invStockReservations)
      .where(
        and(
          eq(invStockReservations.orgId, orgId),
          eq(invStockReservations.status, "ACTIVE"),
          isNotNull(invStockReservations.expiresAt),
          lt(invStockReservations.expiresAt, new Date()),
        ),
      )
      .then(rows => rows[0]?.count ?? 0)
      .catch((err: unknown) => {
        logger.warn("inventory.getHealth: expired-reservations count failed", {
          orgId,
          cause: err instanceof Error ? err.message : String(err),
        });
        return 0;
      });

    const [
      stockCountRows,
      txnCountRows,
      expiredReservations,
      failedImportRows,
      failedExportRows,
      failedWebhookRows,
      failedPublicationRows,
    ] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invStockLevels)
        .where(eq(invStockLevels.orgId, orgId)),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(invStockTransactions)
        .where(eq(invStockTransactions.orgId, orgId)),
      reservationQuery,
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invImportJobs)
        .where(and(eq(invImportJobs.orgId, orgId), eq(invImportJobs.status, "FAILED"))),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invExportJobs)
        .where(and(eq(invExportJobs.orgId, orgId), eq(invExportJobs.status, "FAILED"))),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invWebhookEvents)
        .where(and(eq(invWebhookEvents.orgId, orgId), eq(invWebhookEvents.status, "FAILED"))),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invChannelStockPublications)
        .where(
          and(eq(invChannelStockPublications.orgId, orgId), eq(invChannelStockPublications.status, "FAILED")),
        ),
    ]);

    return {
      ledgerReconciliation: {
        sampleSize: Number(stockCountRows[0]?.count ?? 0),
        transactionCount: txnCountRows[0]?.total ?? 0,
        status: "ok",
      },
      activeExpiredReservations: expiredReservations,
      failedImportJobs: failedImportRows[0]?.count ?? 0,
      failedExportJobs: failedExportRows[0]?.count ?? 0,
      failedWebhookEvents: failedWebhookRows[0]?.count ?? 0,
      failedChannelPublications: failedPublicationRows[0]?.count ?? 0,
    };
  }

  async expireReservations(orgId: string, userId: string) {
    const count = await this.reservation.expireStale(orgId);

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "maintenance.expire_reservations",
      resourceType: "maintenance",
      resourceId: orgId,
      metadata: { expired: count },
    });

    return { expired: count };
  }
}
