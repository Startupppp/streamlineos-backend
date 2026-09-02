import { Inject, Injectable, Logger } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import { StorageMultipartService } from "../storage/storage-multipart.service";
import { FileQuarantineService } from "../storage/file-quarantine.service";
import { StorageService } from "../storage/storage.service";

const STALE_PENDING_SCAN_MS = 24 * 60 * 60 * 1000;
const INFECTED_REVIEW_MS = 48 * 60 * 60 * 1000;
const SWEEP_BATCH = 50;

export interface StorageSweepResult {
  organizations: number;
  multipartAborted: number;
  quarantineExpired: number;
  s3ObjectsDeleted: number;
  deleteFailures: number;
}

@Injectable()
export class CronStorageSweepService {
  private readonly logger = new Logger(CronStorageSweepService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly multipart: StorageMultipartService,
    private readonly quarantine: FileQuarantineService,
    private readonly storage: StorageService,
  ) {}

  async sweep(): Promise<StorageSweepResult> {
    const result: StorageSweepResult = {
      organizations: 0,
      multipartAborted: 0,
      quarantineExpired: 0,
      s3ObjectsDeleted: 0,
      deleteFailures: 0,
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
        `${result.deleteFailures} deletion failure(s) left blocked`,
    );
    return result;
  }

  private async sweepOrg(orgId: string, result: StorageSweepResult): Promise<void> {
    try {
      const aborted = await this.multipart.sweepAbandonedUploads(orgId);
      result.multipartAborted += aborted;
    } catch (err) {
      this.logger.warn(`Multipart sweep failed for org=${orgId}: ${String(err)}`);
    }

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
          `[storage-sweep] S3 delete failed, quarantine record kept so the key stays blocked: org=${orgId} key=${record.storageKey}: ${String(err)}`,
        );
        continue;
      }
      try {
        await this.quarantine.softDelete(record.id);
        result.quarantineExpired += 1;
      } catch (err) {
        result.deleteFailures += 1;
        this.logger.error(
          `[storage-sweep] quarantine soft-delete failed for id=${record.id}: ${String(err)}`,
        );
      }
    }
  }
}
