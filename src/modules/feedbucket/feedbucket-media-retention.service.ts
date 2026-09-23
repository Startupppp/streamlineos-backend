import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { forEachOrg } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { feedbucketAttachments, feedbucketSubmissions } from "../../db/schema";
import { StorageService } from "../storage/storage.service";
import type { FeedbucketMediaStorage } from "./feedbucket-submissions.service";

export const FEEDBUCKET_MEDIA_RETENTION_DAYS = 30;
export const FEEDBUCKET_MEDIA_PURGE_BATCH = 100;
export const FEEDBUCKET_MEDIA_ATTACHMENT_SCAN_CAP = 2000;
export const FEEDBUCKET_MEDIA_PURGE_RUN_BUDGET = 500;
export const FEEDBUCKET_MEDIA_RETENTION_SWEEP = "feedbucket-media-retention";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FeedbucketMediaRetentionResult {
  organizations: number;
  organizationsFailed: number;
  submissionsPurged: number;
  objectsDeleted: number;
  mediaDeleteFailures: number;
  truncated: boolean;
}

@Injectable()
export class FeedbucketMediaRetentionService {
  private readonly logger = new Logger(FeedbucketMediaRetentionService.name);
  private resumeAfterOrgId: string | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(StorageService) private readonly storage: FeedbucketMediaStorage,
  ) {}

  async sweep(now: Date = new Date()): Promise<FeedbucketMediaRetentionResult> {
    const cutoff = new Date(now.getTime() - FEEDBUCKET_MEDIA_RETENTION_DAYS * DAY_MS);
    const result: FeedbucketMediaRetentionResult = {
      organizations: 0,
      organizationsFailed: 0,
      submissionsPurged: 0,
      objectsDeleted: 0,
      mediaDeleteFailures: 0,
      truncated: false,
    };
    const failures: string[] = [];
    const budgetSpent = () =>
      result.submissionsPurged + result.mediaDeleteFailures >= FEEDBUCKET_MEDIA_PURGE_RUN_BUDGET;
    let lastVisitedOrgId: string | null = null;

    const swept = await forEachOrg(
      this.db,
      FEEDBUCKET_MEDIA_RETENTION_SWEEP,
      async (tx, orgId) => {
        lastVisitedOrgId = orgId;
        await this.purgeOrganization(tx, orgId, cutoff, result, failures);
      },
      "write",
      { startAfterOrgId: this.resumeAfterOrgId, stopWhen: budgetSpent },
    );

    result.organizations = swept.organizations;
    result.organizationsFailed = swept.failed;
    if (budgetSpent()) {
      result.truncated = true;
      this.resumeAfterOrgId = lastVisitedOrgId;
    } else {
      this.resumeAfterOrgId = null;
    }

    this.logger.log(
      `[${FEEDBUCKET_MEDIA_RETENTION_SWEEP}] ${result.organizations} org(s) ` +
        `(${result.organizationsFailed} failed), ${result.submissionsPurged} submission(s) purged, ` +
        `${result.objectsDeleted} object(s) deleted, ${result.mediaDeleteFailures} delete failure(s), ` +
        `truncated=${result.truncated}`,
    );

    if (failures.length > 0)
      throw new Error(
        `[${FEEDBUCKET_MEDIA_RETENTION_SWEEP}] feedbucket media purge failed for ` +
          `${failures.length} object(s), left unpurged for the next run: ${failures.join("; ")}`,
      );

    return result;
  }

  private fullyScanned<T extends { id: number }>(
    due: readonly T[],
    attachments: readonly { submissionId: number }[],
    result: FeedbucketMediaRetentionResult,
  ): readonly T[] {
    if (attachments.length < FEEDBUCKET_MEDIA_ATTACHMENT_SCAN_CAP) return due;
    const lastScanned = attachments[attachments.length - 1]?.submissionId;
    if (lastScanned === undefined) return due;
    result.truncated = true;
    this.logger.warn(
      `[${FEEDBUCKET_MEDIA_RETENTION_SWEEP}] the attachment scan cap was reached; submissions from ${lastScanned} up are left for the next run rather than marked purged with objects still stored`,
    );
    return due.filter((submission) => submission.id < lastScanned);
  }

  private async purgeOrganization(
    tx: TenantTx,
    orgId: string,
    cutoff: Date,
    result: FeedbucketMediaRetentionResult,
    failures: string[],
  ): Promise<void> {
    const due = await tx
      .select({
        id: feedbucketSubmissions.id,
        screenshotKey: feedbucketSubmissions.screenshotKey,
        screenshotUrl: feedbucketSubmissions.screenshotUrl,
      })
      .from(feedbucketSubmissions)
      .where(
        and(
          eq(feedbucketSubmissions.orgId, orgId),
          isNotNull(feedbucketSubmissions.deletedAt),
          isNull(feedbucketSubmissions.mediaPurgedAt),
          lt(feedbucketSubmissions.deletedAt, cutoff),
        ),
      )
      .orderBy(asc(feedbucketSubmissions.deletedAt))
      .limit(FEEDBUCKET_MEDIA_PURGE_BATCH);

    if (due.length === 0) return;
    if (due.length === FEEDBUCKET_MEDIA_PURGE_BATCH) result.truncated = true;

    const submissionIds = due.map((row) => row.id);
    const attachments = await tx
      .select({
        submissionId: feedbucketAttachments.submissionId,
        fileKey: feedbucketAttachments.fileKey,
        fileUrl: feedbucketAttachments.fileUrl,
      })
      .from(feedbucketAttachments)
      .where(
        and(
          eq(feedbucketAttachments.orgId, orgId),
          inArray(feedbucketAttachments.submissionId, submissionIds),
        ),
      )
      .orderBy(asc(feedbucketAttachments.submissionId))
      .limit(FEEDBUCKET_MEDIA_ATTACHMENT_SCAN_CAP);

    const covered = this.fullyScanned(due, attachments, result);

    const attachmentKeys = new Map<number, string[]>();
    for (const attachment of attachments) {
      const key = attachment.fileKey ?? attachment.fileUrl;
      if (!key) continue;
      const bucket = attachmentKeys.get(attachment.submissionId);
      if (bucket) bucket.push(key);
      else attachmentKeys.set(attachment.submissionId, [key]);
    }

    const purgedIds: number[] = [];
    for (const submission of covered) {
      const keys = new Set<string>(attachmentKeys.get(submission.id) ?? []);
      const screenshot = submission.screenshotKey ?? submission.screenshotUrl;
      if (screenshot) keys.add(screenshot);

      let failed = false;
      for (const key of keys) {
        try {
          const deleted = await this.storage.deleteFileIfPresent(orgId, key);
          if (deleted) result.objectsDeleted += 1;
        } catch (error) {
          failed = true;
          result.mediaDeleteFailures += 1;
          failures.push(`org ${orgId} submission ${submission.id} key ${key}`);
          this.logger.error(
            `[${FEEDBUCKET_MEDIA_RETENTION_SWEEP}] storage delete failed; the submission stays unpurged and the next run retries it`,
            {
              orgId,
              submissionId: submission.id,
              storageKey: key,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
      if (!failed) purgedIds.push(submission.id);
    }

    if (purgedIds.length === 0) return;

    await tx
      .update(feedbucketSubmissions)
      .set({ mediaPurgedAt: new Date() })
      .where(
        and(
          eq(feedbucketSubmissions.orgId, orgId),
          inArray(feedbucketSubmissions.id, purgedIds),
          isNull(feedbucketSubmissions.mediaPurgedAt),
        ),
      );
    result.submissionsPurged += purgedIds.length;
  }
}
