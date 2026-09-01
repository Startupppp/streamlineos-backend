import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { hrLegalHolds, auditLogs } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { StorageService } from "../storage/storage.service";
import {
  enumerateFileKeyColumns,
  collectSubjectFileKeysWithLegalHold,
  type SubjectFileKey,
} from "../storage/storage-key-catalog";

export interface PurgeManifest {
  blocked: boolean;
  blockReason?: string;
  keys: SubjectFileKey[];
}

export interface PurgeResult {
  blocked: boolean;
  blockReason?: string;
  dryRun: boolean;
  deleted: string[];
  skipped: string[];
  failed: Array<{ key: string; reason: string }>;
  manifest: SubjectFileKey[];
}

@Injectable()
export class GdprStoragePurgeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  async buildManifest(
    userId: string,
    orgIds: string[],
  ): Promise<PurgeManifest> {
    const hasHold = await this.hasActiveLegalHold(userId, orgIds);
    if (hasHold) {
      return {
        blocked: true,
        blockReason: "active-legal-hold",
        keys: [],
      };
    }

    const columns = await enumerateFileKeyColumns(this.db);
    const keys = await collectSubjectFileKeysWithLegalHold(
      this.db,
      userId,
      orgIds,
      columns,
    );
    return { blocked: false, keys };
  }

  async purgeSubjectStorage(
    userId: string,
    orgIds: string[],
    actorUserId: string,
    primaryOrgId: string,
    options: { dryRun: boolean },
  ): Promise<PurgeResult> {
    const manifest = await this.buildManifest(userId, orgIds);

    if (manifest.blocked) {
      return {
        blocked: true,
        blockReason: manifest.blockReason,
        dryRun: options.dryRun,
        deleted: [],
        skipped: [],
        failed: [],
        manifest: [],
      };
    }

    if (options.dryRun) {
      return {
        blocked: false,
        dryRun: true,
        deleted: [],
        skipped: [],
        failed: [],
        manifest: manifest.keys,
      };
    }

    const deleted: string[] = [];
    const failed: Array<{ key: string; reason: string }> = [];

    for (const entry of manifest.keys) {
      try {
        await this.storage.deleteFile(primaryOrgId, entry.key);
        deleted.push(entry.key);
      } catch (err) {
        failed.push({
          key: entry.key,
          reason: err instanceof Error ? err.message : "unknown",
        });
      }
    }

    await this.recordErasureAudit(
      userId,
      actorUserId,
      primaryOrgId,
      deleted.length,
      failed.length,
    );

    return {
      blocked: false,
      dryRun: false,
      deleted,
      skipped: [],
      failed,
      manifest: manifest.keys,
    };
  }

  private async hasActiveLegalHold(
    userId: string,
    orgIds: string[],
  ): Promise<boolean> {
    const orgId = orgIds[0];
    if (!orgId) return false;

    const [row] = await this.db
      .select({ id: hrLegalHolds.id })
      .from(hrLegalHolds)
      .where(
        and(
          eq(hrLegalHolds.subjectUserId, userId),
          eq(hrLegalHolds.orgId, orgId),
          eq(hrLegalHolds.status, "active"),
          isNull(hrLegalHolds.deletedAt),
        ),
      )
      .limit(1);

    return Boolean(row);
  }

  private async recordErasureAudit(
    subjectUserId: string,
    actorUserId: string,
    orgId: string,
    deletedCount: number,
    failedCount: number,
  ) {
    await this.db.insert(auditLogs).values({
      action: "subject.storage.erased",
      userId: actorUserId,
      orgId,
      targetId: subjectUserId,
      targetType: "user",
      metadata: {
        keyCount: deletedCount,
        failedCount,
        subjectUserIdHash: this.hashId(subjectUserId),
      },
      isPlatformEvent: false,
    });
  }

  private hashId(id: string): string {
    return createHash("sha256").update(id).digest("hex").slice(0, 16);
  }
}
