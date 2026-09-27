import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { NotificationsService } from "../../notifications/notifications.service";
import { AuditService } from "../../../common/audit/audit.service";
import { PROCESS_CELL_ID } from "../../../common/cell-resources/cell-id";
import {
  snapshotIfNeeded,
  resyncPageLinks,
  type KbTransaction,
} from "./kb-page-edit.util";
import { extractMentionUserIds } from "./kb-page-content.util";
import { deferKbMentionNotifications } from "./kb-page-mention-notifications";
import type { KbPageContent } from "../../../db/schema/kb/pages";
import { KbWriteMetrics } from "../analytics/kb-write-metrics";

export type KbPageChangeActor = {
  userId: string;
  membershipId: number | null;
};

export type KbPageChangedContent = {
  newContent: KbPageContent;
  previousContent: KbPageContent | null;
  changeSummary?: string | null;
  forced?: boolean;
};

export type CommitPageChangeInput = {
  orgId: string;
  actor: KbPageChangeActor;
  action: string;
  page: {
    id: number;
    title: string;
    contentRevision: number;
    aclRevision: number;
    contentText: string | null;
  };
  changed: {
    content?: KbPageChangedContent;
  };
  writeOutcome?: "created" | "updated";
};

export type CommitManyPageChangesInput = {
  orgId: string;
  pages: ReadonlyArray<{
    id: number;
    contentRevision: number;
    aclRevision: number;
    contentText: string | null;
  }>;
};

@Injectable()
export class KbPageWriterService {
  private readonly logger = new Logger(KbPageWriterService.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  async commitPageChange(
    tx: KbTransaction,
    input: CommitPageChangeInput,
  ): Promise<void> {
    const metrics = KbWriteMetrics.begin({ orgId: input.orgId, orgCell: PROCESS_CELL_ID });
    try {
      const { orgId, actor, page, changed, action } = input;

      if (changed.content !== undefined) {
        const {
          newContent,
          previousContent,
          changeSummary = null,
          forced = false,
        } = changed.content;

        await snapshotIfNeeded(
          tx,
          orgId,
          {
            id: page.id,
            title: page.title,
            content: newContent,
            contentText: page.contentText,
          },
          actor.userId,
          changeSummary,
          forced,
          actor.membershipId,
        );

        await resyncPageLinks(tx, orgId, page.id, newContent);

        const prevMentionSet = new Set(extractMentionUserIds(previousContent));
        const addedMentions = extractMentionUserIds(newContent).filter(
          (id) => !prevMentionSet.has(id),
        );
        if (addedMentions.length > 0) {
          await deferKbMentionNotifications(this.notifications, this.logger, {
            orgId,
            userIds: addedMentions,
            pageId: page.id,
            pageTitle: page.title,
            actorId: actor.userId,
          });
        }
      }

      await this.audit.logCritical({
        action,
        userId: actor.userId,
        orgId,
        resourceType: "kb_page",
        resourceId: String(page.id),
        actorMembershipId: actor.membershipId ?? undefined,
        metadata: { pageTitle: page.title },
      });

      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "kb_page",
        aggregateId: String(page.id),
        aggregateVersion: Date.now(),
        eventType: "kb.content.index",
        payload: {
          contentType: "page",
          contentId: page.id,
          contentRevision: page.contentRevision,
          aclRevision: page.aclRevision,
        },
        occurredAt: new Date(),
      });
      metrics.finish(input.writeOutcome ?? "updated");
    } catch (error) {
      metrics.finish("error");
      throw error;
    }
  }

  async commitManyPageChanges(
    tx: KbTransaction,
    input: CommitManyPageChangesInput,
  ): Promise<void> {
    const { orgId, pages } = input;
    const toIndex = pages.filter((p) => Boolean(p.contentText?.trim()));
    if (toIndex.length === 0) return;
    await OutboxWriter.emitMany(
      tx,
      toIndex.map((p) => ({
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "kb_page",
        aggregateId: String(p.id),
        aggregateVersion: Date.now(),
        eventType: "kb.content.index",
        payload: {
          contentType: "page",
          contentId: p.id,
          contentRevision: p.contentRevision,
          aclRevision: p.aclRevision,
        },
        occurredAt: new Date(),
      })),
    );
  }
}
