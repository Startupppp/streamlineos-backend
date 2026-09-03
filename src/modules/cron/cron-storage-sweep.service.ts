import { Inject, Injectable, Logger } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import { StorageMultipartService } from "../storage/storage-multipart.service";
import { FileQuarantineService } from "../storage/file-quarantine.service";
import { StorageService } from "../storage/storage.service";
import {
  StoragePendingPurgeService,
  type PendingPurgeRow,
} from "../storage/storage-pending-purge.service";

const STALE_PENDING_SCAN_MS = 24 * 60 * 60 * 1000;
const INFECTED_REVIEW_MS = 48 * 60 * 60 * 1000;
const SWEEP_BATCH = 50;
const PENDING_PURGE_BATCH = 100;

export interface StorageSweepResult {
  organizations: number;
  multipartAborted: number;
  quarantineExpired: number;
  s3ObjectsDeleted: number;
  deleteFailures: number;
  pendingPurgeConfirmed: number;
  pendingPurgeFailed: number;
}

@Injectable()
export class CronStorageSweepService {
  private readonly logger = new Logger(CronStorageSweepService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly multipart: StorageMultipartService,
    private readonly quarantine: FileQuarantineService,
    private readonly storage: StorageService,
    private readonly pendingPurge: StoragePendingPurgeService,
  ) {}

  async sweep(): Promise<StorageSweepResult> {
    const result: StorageSweepResult = {
      organizations: 0,
      multipartAborted: 0,
      quarantineExpired: 0,
      s3ObjectsDeleted: 0,
      deleteFailures: 0,
      pendingPurgeConfirmed: 0,
      pendingPurgeFailed: 0,
    };

    // forEachOrg, not a hand-rolled enumeration: it opens the tenant transaction that sets
    // the org GUC, without which every quarantine and multipart read here dies 42501.
    const swept = await forEachOrg(this.db, "storage-sweep", async (_tx, orgId) => {
      await this.sweepOrg(orgId, result);
    });
    result.organizations = swept.organizations;

    this.logger.log(
      `[storage-sweep] ${result.organizations} orgs, ` +
        `${result.multipartAborted} multipart aborted, ` +
        `${result.quarantineExpired} quarantine expired, ` +
        `${result.s3ObjectsDeleted} S3 objects deleted, ` +
        `${result.pendingPurgeConfirmed} pending-purge confirmed, ` +
        `${result.pendingPurgeFailed} pending-purge still failing, ` +
        `${result.deleteFailures} deletion failure(s) left blocked`,
    );
    return result;
  }

  /*
   * The organization purge and e-sign document deletion both open a
   * `storage_pending_purge` row BEFORE attempting the object delete, precisely
   * so a crash or a provider failure between the two leaves a record. Nothing
   * had ever read one back, so every row those writers parked at `pending` or
   * `failed` was an object that would never be deleted and a leak no other
   * sweep could find — the pointer lived only in this table. This is that
   * reader.
   */
  private async drainPendingPurge(
    orgId: string,
    result: StorageSweepResult,
  ): Promise<void> {
    let rows: PendingPurgeRow[];
    try {
      rows = await this.pendingPurge.listForRetry(orgId, PENDING_PURGE_BATCH);
    } catch (err) {
      this.logger.error(`[storage-sweep] pending-purge scan failed: ${String(err)}`, { orgId });
      return;
    }

    for (const row of rows) {
      // deleteFileIfPresent, not deleteFile: an object already gone is the purge
      // succeeding, and retrying it forever is what would keep the row alive.
      try {
        await this.storage.deleteFileIfPresent(orgId, row.storageKey);
      } catch (err) {
        result.pendingPurgeFailed += 1;
        try {
          await this.pendingPurge.markFailed(row.id, String(err));
        } catch (markErr) {
          this.logger.error(
            `[storage-sweep] pending-purge failure could not be recorded: ${String(markErr)}`,
            { orgId, purpose: row.purpose },
          );
        }
        continue;
      }
      // Confirm only after the object is gone, never before: the row is the
      // write-ahead record and confirming first would discard it while the
      // object survived.
      try {
        await this.pendingPurge.markConfirmed(row.id);
        result.pendingPurgeConfirmed += 1;
      } catch (err) {
        this.logger.error(
          `[storage-sweep] pending-purge confirmation failed; row is retried next sweep: ${String(err)}`,
          { orgId, purpose: row.purpose },
        );
      }
    }
  }

  private async sweepOrg(orgId: string, result: StorageSweepResult): Promise<void> {
    try {
      const aborted = await this.multipart.sweepAbandonedUploads(orgId);
      result.multipartAborted += aborted;
    } catch (err) {
      this.logger.warn(`Multipart sweep failed: ${String(err)}`, { orgId });
    }

    await this.drainPendingPurge(orgId, result);

    const now = Date.now();
    const stalePendingCutoff = new Date(now - STALE_PENDING_SCAN_MS);
    const infectedCutoff = new Date(now - INFECTED_REVIEW_MS);

    const toExpire = [
      ...(await this.quarantine.listForSweep(
        orgId,
        ["infected", "error"],
        infectedCutoff,
        SWEEP_BATCH,
      )),
      ...(await this.quarantine.listForSweep(
        orgId,
        ["pending_scan"],
        stalePendingCutoff,
        SWEEP_BATCH,
      )),
    ];

    for (const record of toExpire) {
      // isKeyBlocked ignores soft-deleted records, so soft-deleting before the object is
      // gone would publish an infected file. The record stays and the next sweep retries.
      try {
        await this.storage.deleteFile(orgId, record.storageKey);
        result.s3ObjectsDeleted += 1;
      } catch (err) {
        result.deleteFailures += 1;
        this.logger.error(
          `[storage-sweep] S3 delete failed, quarantine record kept so the key stays blocked: ${String(err)}`,
          { orgId, storageKey: record.storageKey },
        );
        continue;
      }
      try {
        await this.quarantine.softDelete(record.id);
        result.quarantineExpired += 1;
      } catch (err) {
        result.deleteFailures += 1;
        this.logger.error(
          `[storage-sweep] quarantine soft-delete failed: ${String(err)}`,
          { quarantineId: record.id },
        );
      }
    }
  }
}
