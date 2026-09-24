import { Inject, Injectable } from "@nestjs/common";
import { KbPageTrashService } from "../kb/wiki/kb-page-trash.service";
import { KbSettingsService } from "../kb/core/kb-settings.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import { AuditService } from "../../common/audit/audit.service";
import { purgeSourceRemovedLinks } from "../kb/linked-documents/kb-linked-document-purge";

const LINKED_DOCUMENT_PURGE_BATCH = 200;

@Injectable()
export class CronKbService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly trash: KbPageTrashService,
    private readonly settings: KbSettingsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The knowledge base's grace-period purge: pages past the organisation's trash retention, and entries for HR
   * documents that were removed more than 30 days ago (decision D11). Both are things readers stopped seeing the
   * moment they were removed, kept only so a person could still find them for a while.
   */
  async purgeExpiredTrash(): Promise<{ orgsProcessed: number; purgedCount: number; linkedDocumentsPurged: number }> {
    let purgedCount = 0;
    let linkedDocumentsPurged = 0;

    const result = await forEachOrg(this.db, "kb-trash-purge", async (tx, orgId) => {
      const { trashRetentionDays } = await this.settings.getOrgSettings(orgId);
      const olderThan = new Date(Date.now() - trashRetentionDays * 86_400_000);
      const count = await this.trash.purgeExpired(orgId, olderThan);
      purgedCount += count;

      const links = await purgeSourceRemovedLinks(tx, orgId, new Date(), LINKED_DOCUMENT_PURGE_BATCH);
      if (links.purged === 0) return;
      linkedDocumentsPurged += links.purged;
      await this.audit.logCritical({
        action: "kb.hr_link.purged",
        systemActor: "cron:kb-trash-purge",
        orgId,
        targetId: orgId,
        targetType: "kb_linked_documents",
        metadata: { purged: links.purged, truncated: links.truncated, linkedDocumentIds: links.linkedDocumentIds },
      });
    });

    return { orgsProcessed: result.succeeded, purgedCount, linkedDocumentsPurged };
  }
}
