import { Injectable, Inject, type OnModuleInit } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { jobBoardPostings, jobPostings } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import {
  OutboxConsumerRegistry,
  type OutboxEventRow,
} from "../../../../common/outbox/outbox-consumer.registry";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { logger } from "../../../../common/logger/logger.service";
import { ProviderCredentialsService } from "../integrations/provider-credentials.service";
import { BoardVendorError, resolveBoard } from "./job-board-adapters";
import { markBlocked, markFailed, markLive } from "./job-board-publication";
import { BOARD_PUBLISH_REQUESTED, BOARD_UNPUBLISH_REQUESTED } from "./job-board-publisher.service";

/**
 * The run side of distribution: the only place in the codebase that talks to a
 * job board, and the only place a posting becomes `LIVE`.
 *
 * It runs from the outbox, so the advertisement request survives a crash and is
 * retried; `job_board_postings` is keyed `(org, job, platform)` and the write is
 * an update of that one row, so a retry converges rather than duplicating. A
 * vendor refusal is recorded as `FAILED` with the vendor's own words, and the
 * event is **not** rethrown for a refusal — a 422 on a job description will
 * never succeed on retry, and rethrowing would spin the worker until the event
 * dead-lettered with the reason buried in a log line instead of on the row the
 * recruiter is looking at.
 *
 * A transport failure is different and is rethrown, because that is exactly the
 * case retrying exists for.
 */
@Injectable()
export class JobBoardOutboxConsumer implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: OutboxConsumerRegistry,
    private readonly credentials: ProviderCredentialsService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      eventType: BOARD_PUBLISH_REQUESTED,
      handle: (event) => this.publish(event),
    });
    this.registry.register({
      eventType: BOARD_UNPUBLISH_REQUESTED,
      handle: (event) => this.unpublish(event),
    });
  }

  private read(event: OutboxEventRow): { postingId: number; jobPostingId: number; platform: string } | null {
    const payload =
      typeof event.payload === "object" && event.payload !== null
        ? (event.payload as Record<string, unknown>)
        : {};
    const postingId = Number(payload.postingId);
    const jobPostingId = Number(payload.jobPostingId);
    const platform = typeof payload.platform === "string" ? payload.platform : "";
    if (!Number.isInteger(postingId) || !Number.isInteger(jobPostingId) || !platform) return null;
    return { postingId, jobPostingId, platform };
  }

  private async publish(event: OutboxEventRow): Promise<void> {
    const parsed = this.read(event);
    if (!parsed) {
      logger.warn("[job-board] publish event carried an unusable payload", { eventId: event.eventId });
      return;
    }
    const orgId = event.organizationId;

    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const job = await tx.query.jobPostings.findFirst({
        where: and(eq(jobPostings.id, parsed.jobPostingId), eq(jobPostings.orgId, orgId)),
        columns: { id: true, title: true, description: true, location: true, type: true },
      });
      if (!job) return;

      const credentials = await this.credentials.forPlatform(orgId, parsed.platform);
      const resolved = resolveBoard(parsed.platform, credentials);
      if (!("adapter" in resolved)) {
        /**
         * The integration was disconnected between queueing and running. That
         * is a blocked state, not a failure — nothing was refused, because
         * nothing was sent.
         */
        await tx
          .update(jobBoardPostings)
          .set(markBlocked(resolved.code, resolved.message))
          .where(and(eq(jobBoardPostings.id, parsed.postingId), eq(jobBoardPostings.orgId, orgId)));
        return;
      }

      const now = new Date();
      try {
        const result = await resolved.adapter.post(resolved.credentials, {
          jobId: job.id,
          title: job.title,
          description: job.description,
          location: job.location,
          employmentType: job.type,
        });
        await tx
          .update(jobBoardPostings)
          .set({ ...markLive(result.externalPostingId, result.url, now), postedAt: now })
          .where(and(eq(jobBoardPostings.id, parsed.postingId), eq(jobBoardPostings.orgId, orgId)));
      } catch (error) {
        const detail =
          error instanceof BoardVendorError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        await tx
          .update(jobBoardPostings)
          .set(markFailed(detail, now))
          .where(and(eq(jobBoardPostings.id, parsed.postingId), eq(jobBoardPostings.orgId, orgId)));
        logger.warn("[job-board] vendor refused a posting", {
          orgId,
          platform: parsed.platform,
          jobPostingId: parsed.jobPostingId,
          detail,
        });
        /**
         * A refusal with a status is the vendor's answer and will not change on
         * retry; the row now carries it. A transport failure has no status and
         * is exactly what retrying is for, so it goes back to the worker.
         */
        if (error instanceof BoardVendorError && error.httpStatus !== null) return;
        throw error;
      }
    });
  }

  private async unpublish(event: OutboxEventRow): Promise<void> {
    const parsed = this.read(event);
    if (!parsed) return;
    const orgId = event.organizationId;

    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const [row] = await tx
        .select({ externalPostingId: jobBoardPostings.externalPostingId })
        .from(jobBoardPostings)
        .where(and(eq(jobBoardPostings.id, parsed.postingId), eq(jobBoardPostings.orgId, orgId)))
        .limit(1);
      if (!row?.externalPostingId) return;

      const credentials = await this.credentials.forPlatform(orgId, parsed.platform);
      const resolved = resolveBoard(parsed.platform, credentials);
      if (!("adapter" in resolved)) return;

      const now = new Date();
      try {
        await resolved.adapter.unpublish(resolved.credentials, row.externalPostingId);
        await tx
          .update(jobBoardPostings)
          .set({ status: "CLOSED", statusDetail: null, lastSyncedAt: now })
          .where(and(eq(jobBoardPostings.id, parsed.postingId), eq(jobBoardPostings.orgId, orgId)));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await tx
          .update(jobBoardPostings)
          .set(markFailed(detail, now))
          .where(and(eq(jobBoardPostings.id, parsed.postingId), eq(jobBoardPostings.orgId, orgId)));
        if (error instanceof BoardVendorError && error.httpStatus !== null) return;
        throw error;
      }
    });
  }
}
