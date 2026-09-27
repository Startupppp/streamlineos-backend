import { Inject, Injectable } from "@nestjs/common";
import { KbPageTrashService } from "../kb/wiki/kb-page-trash.service";
import { KbSettingsService } from "../kb/core/kb-settings.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import { AuditService } from "../../common/audit/audit.service";
import { purgeSourceRemovedLinks } from "../kb/linked-documents/kb-linked-document-purge";
import { KbContradictionScannerService } from "../kb/content-health/kb-contradiction-scanner.service";

const LINKED_DOCUMENT_PURGE_BATCH = 200;

@Injectable()
export class CronKbService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly trash: KbPageTrashService,
    private readonly settings: KbSettingsService,
    private readonly audit: AuditService,
    private readonly contradictions: KbContradictionScannerService,
  ) {}

  async scanContradictions(): Promise<{
    orgsProcessed: number;
    orgsFailed: number;
    detected: number;
  }> {
    const result = await this.contradictions.runContradictionScanAllOrgs();
    return {
      orgsProcessed: result.succeeded,
      orgsFailed: result.failed,
      detected: result.detected,
    };
  }

  async purgeExpiredTrash(): Promise<{
    orgsProcessed: number;
    purgedCount: number;
    linkedDocumentsPurged: number;
  }> {
    let purgedCount = 0;
    let linkedDocumentsPurged = 0;

    const result = await forEachOrg(
      this.db,
      "kb-trash-purge",
      async (tx, orgId) => {
        const { trashRetentionDays } =
          await this.settings.getOrgSettings(orgId);
        const olderThan = new Date(
          Date.now() - trashRetentionDays * 86_400_000,
        );
        const count = await this.trash.purgeExpired(orgId, olderThan);
        purgedCount += count;

        const links = await purgeSourceRemovedLinks(
          tx,
          orgId,
          new Date(),
          LINKED_DOCUMENT_PURGE_BATCH,
        );
        if (links.purged === 0) return;
        linkedDocumentsPurged += links.purged;
        await this.audit.logCritical({
          action: "kb.hr_link.purged",
          systemActor: "cron:kb-trash-purge",
          orgId,
          targetId: orgId,
          targetType: "kb_linked_documents",
          metadata: {
            purged: links.purged,
            truncated: links.truncated,
            linkedDocumentIds: links.linkedDocumentIds,
          },
        });
      },
    );

    return {
      orgsProcessed: result.succeeded,
      purgedCount,
      linkedDocumentsPurged,
    };
  }
}
