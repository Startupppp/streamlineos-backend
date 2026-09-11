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
import { BadRequestException, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  feedbucketAttachments,
  feedbucketSubmissions,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { StorageService } from "../../storage/storage.service";
import type { NotificationsService } from "../../notifications/notifications.service";
import type { ProjectsTicketsService } from "../../build/core/projects-tickets.service";
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

export interface FeedbucketSubmitDeps {
  readonly db: Db;
  readonly storage: StorageService;
  readonly notifications: NotificationsService;
  readonly ticketsService: ProjectsTicketsService;
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

type Upload = { url: string; size: number; mimeType: string };

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

  let screenshotUpload: Upload | undefined;
  if (screenshot) {
    assertScreenshotAcceptable(screenshot);

    screenshotUpload = await deps.storage.uploadCompressed(
      widget.orgId,
      screenshot.buffer,
      `feedbucket/${folder}/screenshots`,
      screenshot.originalname,
      screenshot.mimetype,
    );
  }

  let recordingUpload: Upload | undefined;
  if (recording) {
    if (recording.size > MAX_RECORDING_BYTES) {
      throw new BadRequestException("Recording must be under 100MB");
    }
    const rawMime = recording.mimetype.split(";")[0]?.trim() ?? "";
    const storeMime = rawMime.startsWith("video/") ? rawMime : "video/webm";
    recordingUpload = await deps.storage.uploadCompressed(
      widget.orgId,
      recording.buffer,
      `feedbucket/${folder}/recordings`,
      recording.originalname || "recording.webm",
      storeMime,
    );
  }

  const screenshotUrl = screenshotUpload?.url;
  const recordingUrl = recordingUpload?.url;

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
          fileUrl: screenshotUpload.url,
          fileSize: screenshotUpload.size,
          fileName: screenshot.originalname,
          mimeType: screenshotUpload.mimeType,
        });

      if (recording && recordingUpload)
        await tx.insert(feedbucketAttachments).values({
          orgId: widget.orgId,
          submissionId,
          fileUrl: recordingUpload.url,
          mimeType: recordingUpload.mimeType,
          fileName: recording.originalname,
          fileSize: recordingUpload.size,
        });

      if (widget.autoCreateTicket && widget.projectId) {
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
              ? `/projects/${widget.projectId}/feedbucket/${submissionId}`
              : `/projects/feedbucket`,
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
  type: string,
  message: string,
  media: {
    screenshot?: Express.Multer.File;
    screenshotUrl?: string;
    recordingUrl?: string;
  },
) {
  const projectId = widget.projectId;
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
          title: message.slice(0, 255) || `${type} feedback`,
          description: parts.join(""),
          type: widget.defaultTicketType,
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
