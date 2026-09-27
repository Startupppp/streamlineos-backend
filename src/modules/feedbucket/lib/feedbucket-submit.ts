/**
 * The public Feedbucket submission pipeline: store the uploaded media, write the
 * submission and its attachment rows in one tenant transaction, then defer the
 * auto-ticket link to after commit.
 *
 * This is a different failure mode from the rest of the public controller. The
 * `config` and `ai-assist` routes are read/analyse paths that answer inline;
 * this one is a durable multi-table write with post-commit side effects, and the
 * auto-link half deliberately swallows its own failures (a lost ticket link must
 * never lose the feedback that was already committed).
 */
import { BadRequestException, HttpException, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  feedbucketAttachments,
  feedbucketSubmissions,
  type FeedbucketAssigneeRules,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { StorageService } from "../../storage/storage.service";
import type { MediaTransformRunner } from "../../storage/media-transform.runner";
import {
  planMedia,
  queueMediaTransforms,
  type PendingMediaTransform,
  type PlannedMedia,
} from "../feedbucket-media-transforms";
import type { NotificationsService } from "../../notifications/notifications.service";
import type { ProjectsTicketsCreateService } from "../../build/core/tickets/projects-tickets-create.service";
import {
  runInTenantTransaction,
  runInNewTenantTransaction,
} from "../../../common/tenant/run-in-tenant-transaction";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import {
  MAX_RECORDING_BYTES,
  assertScreenshotAcceptable,
  type FeedbucketWidget,
} from "./feedbucket-public-request";
import type { PublicSubmitInput } from "../feedbucket.schemas";
import {
  deriveFeedbackTicketTitle,
  resolveFeedbucketTicketTarget,
} from "../feedbucket-ticket-routing";

export interface FeedbucketSubmitDeps {
  readonly db: Db;
  readonly storage: StorageService;
  /** Encodes planned media after commit, so the public request never waits on ffmpeg. */
  readonly transforms: MediaTransformRunner;
  readonly notifications: NotificationsService;
  readonly ticketsService: ProjectsTicketsCreateService;
  readonly logger: Logger;
  /**
   * Bound `FeedbucketPublicService.createSubmission`. Passed as a closure so the
   * lib never imports the controller's collaborators back by name.
   */
  readonly createSubmission: (
    widget: FeedbucketWidget,
    dto: PublicSubmitInput,
    screenshotUrl: string | undefined,
  ) => Promise<number>;
}

export interface PublicSubmitFiles {
  screenshot?: Express.Multer.File;
  recording?: Express.Multer.File;
}

function projectFolder(widget: FeedbucketWidget): string {
  return widget.projectId
    ? `project-${widget.projectId}`
    : `org-${widget.orgId}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function submitPublicFeedback(
  deps: FeedbucketSubmitDeps,
  widget: FeedbucketWidget,
  dto: PublicSubmitInput,
  files: PublicSubmitFiles,
): Promise<{ ok: true }> {
  const folder = projectFolder(widget);
  const { screenshot, recording } = files;

  if ((screenshot || recording) && !deps.transforms.hasCapacity())
    throw new HttpException({ message: "Media processing is saturated — retry shortly" }, 503);

  const pendingTransforms: PendingMediaTransform[] = [];

  let screenshotUpload: PlannedMedia | undefined;
  if (screenshot) {
    assertScreenshotAcceptable(screenshot);

    screenshotUpload = await planMedia(
      deps.storage,
      widget.orgId,
      `feedbucket/${folder}/screenshots`,
      { buffer: screenshot.buffer, fileName: screenshot.originalname, mimeType: screenshot.mimetype },
      pendingTransforms,
    );
  }

  let recordingUpload: PlannedMedia | undefined;
  if (recording) {
    if (recording.size > MAX_RECORDING_BYTES) {
      throw new BadRequestException("Recording must be under 100MB");
    }
    const rawMime = recording.mimetype.split(";")[0]?.trim() ?? "";
    const storeMime = rawMime.startsWith("video/") ? rawMime : "video/webm";
    recordingUpload = await planMedia(
      deps.storage,
      widget.orgId,
      `feedbucket/${folder}/recordings`,
      { buffer: recording.buffer, fileName: recording.originalname || "recording.webm", mimeType: storeMime },
      pendingTransforms,
    );
  }

  // Keys, not URLs: stored objects are served by signed URL, never publicly.
  const screenshotUrl = screenshotUpload?.key;
  const recordingUrl = recordingUpload?.key;

  await runInTenantTransaction(
    deps.db,
    async (tx) => {
      const submissionId = await deps.createSubmission(
        widget,
        dto,
        screenshotUrl,
      );

      if (screenshot && screenshotUpload)
        await tx.insert(feedbucketAttachments).values({
          submissionId,
          orgId: widget.orgId,
          fileUrl: screenshotUpload.key,
          fileSize: screenshotUpload.size,
          fileName: screenshot.originalname,
          mimeType: screenshotUpload.mimeType,
        });

      if (recording && recordingUpload)
        await tx.insert(feedbucketAttachments).values({
          orgId: widget.orgId,
          submissionId,
          fileUrl: recordingUpload.key,
          mimeType: recordingUpload.mimeType,
          fileName: recording.originalname,
          fileSize: recordingUpload.size,
        });

      await queueMediaTransforms(deps.storage, deps.transforms, widget.orgId, pendingTransforms);

      if (widget.autoCreateTicket && (widget.projectId ?? widget.defaultProjectId)) {
        const deferred = () =>
          autoLinkTicket(deps, widget, submissionId, dto.type, dto.message, {
            screenshot,
            screenshotUrl,
            recordingUrl,
          });
        if (!registerAfterCommit(deferred)) void deferred();
      }

      if (widget.createdBy) {
        void deps.notifications
          .create({
            orgId: widget.orgId,
            userId: widget.createdBy,
            type: "INFO",
            category: "SYSTEM",
            sourceModule: "feedbucket",
            title: "New Feedback Received",
            message: `New ${dto.type} feedback received via widget "${widget.name}"`,
            link: widget.projectId
              ? `/build/${widget.projectId}/feedbucket/${submissionId}`
              : `/build`,
          })
          .catch(() => undefined);
      }
    },
    { orgId: widget.orgId },
  );

  return { ok: true };
}

async function autoLinkTicket(
  deps: FeedbucketSubmitDeps,
  widget: FeedbucketWidget,
  submissionId: number,
  type: keyof FeedbucketAssigneeRules,
  message: string,
  media: {
    screenshot?: Express.Multer.File;
    screenshotUrl?: string;
    recordingUrl?: string;
  },
) {
  const { projectId, assigneeMembershipId } = resolveFeedbucketTicketTarget(widget, type);
  if (!projectId) return;
  try {
    await runInNewTenantTransaction(deps.db, widget.orgId, async () => {
      const actingUserId = widget.createdBy ?? widget.orgId;
      const parts: string[] = [
        `<p><strong>Feedback type:</strong> ${escapeHtml(type)}</p>`,
      ];
      if (message.trim())
        parts.push(`<p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`);
      if (media.screenshotUrl)
        parts.push(
          `<p><img src="${escapeHtml(media.screenshotUrl)}" alt="Feedback screenshot"></p>`,
        );
      if (media.recordingUrl)
        parts.push(
          `<p><strong>Screen recording:</strong> <a href="${escapeHtml(media.recordingUrl)}" target="_blank" rel="noopener noreferrer">Watch recording</a></p>`,
        );
      const ticket = await deps.ticketsService.createFromFeedback(
        widget.orgId,
        actingUserId,
        projectId,
        {
          title: deriveFeedbackTicketTitle(message, type),
          description: parts.join(""),
          type: widget.defaultTicketType,
          assigneeMembershipId,
        },
      );
      await deps.db
        .update(feedbucketSubmissions)
        .set({ linkedTicketId: ticket.id })
        .where(
          and(
            eq(feedbucketSubmissions.id, submissionId),
            eq(feedbucketSubmissions.orgId, widget.orgId),
          ),
        );
    });
  } catch (err) {
    deps.logger.warn(
      `linkFeedbackToTicket failed for submission ${submissionId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
