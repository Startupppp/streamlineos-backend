import { Injectable, Inject } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { jobBoardPostings } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import { nextAggregateVersion } from "../../../../common/outbox/aggregate-version";
import { ProviderCredentialsService } from "../integrations/provider-credentials.service";
import { resolveBoard, type BoardOutcome } from "./job-board-adapters";
import { markBlocked, markQueued } from "./job-board-publication";

export const BOARD_PUBLISH_REQUESTED = "job.board.publish_requested";
export const BOARD_UNPUBLISH_REQUESTED = "job.board.unpublish_requested";

export interface PublishTarget {
  readonly jobId: number;
  readonly platform: string;
}

/**
 * The queue side of distribution: decide, record, and hand the network call to
 * the outbox.
 *
 * The old `publish` called the adapter inside the request. Two things were
 * wrong with that beyond the fake success. A board is a third party, so its
 * outage became this endpoint's latency and held a pooled database connection
 * for the length of it — the thing `backend/CLAUDE.md` §4 names outright. And a
 * crash between "we posted" and "we recorded that we posted" left an
 * advertisement live that the product had no id for and could never close.
 *
 * Now the row and the event commit together (§4's mechanism 2: losing the
 * effect would be a correctness bug, so it is an outbox event, not an
 * after-commit hook), and the consumer is what talks to the vendor. A blocked
 * platform is never queued at all: it gets a `BLOCKED` row carrying its code so
 * the board settings screen can explain it, and no event is written for work
 * nobody can do.
 */
@Injectable()
export class JobBoardPublisherService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly credentials: ProviderCredentialsService,
  ) {}

  /**
   * Queue one job onto each requested board.
   *
   * Runs inside the caller's tenant transaction — `this.db` is the request
   * transaction — so the publication rows and the outbox events are one commit.
   */
  async queue(orgId: string, jobId: number, platforms: readonly string[]): Promise<BoardOutcome[]> {
    const outcomes: BoardOutcome[] = [];

    for (const platform of platforms) {
      const credentials = await this.credentials.forPlatform(orgId, platform);
      const resolved = resolveBoard(platform, credentials);

      if (!("adapter" in resolved)) {
        await this.upsert(orgId, jobId, platform, markBlocked(resolved.code, resolved.message));
        outcomes.push(resolved);
        continue;
      }

      const postingId = await this.upsert(orgId, jobId, platform, {
        ...markQueued(),
        externalPostingId: null,
        externalPostUrl: null,
        lastAttemptAt: null,
        lastSyncedAt: null,
      });

      await OutboxWriter.emit(this.db, {
        eventId: randomUUID(),
        occurredAt: new Date(),
        organizationId: orgId,
        aggregateType: "job_board_posting",
        aggregateId: String(postingId),
        aggregateVersion: await nextAggregateVersion(this.db, {
          organizationId: orgId,
          aggregateType: "job_board_posting",
          aggregateId: String(postingId),
        }),
        eventType: BOARD_PUBLISH_REQUESTED,
        payload: { postingId, jobPostingId: jobId, platform },
      });

      outcomes.push({ platform, status: "QUEUED", postingId });
    }

    return outcomes;
  }

  /** Ask a board to take the advertisement down. Same queue, same honesty. */
  async queueUnpublish(orgId: string, jobId: number, platform: string): Promise<BoardOutcome> {
    const [row] = await this.db
      .select({ id: jobBoardPostings.id, externalPostingId: jobBoardPostings.externalPostingId })
      .from(jobBoardPostings)
      .where(
        and(
          eq(jobBoardPostings.orgId, orgId),
          eq(jobBoardPostings.jobPostingId, jobId),
          eq(jobBoardPostings.platform, platform),
        ),
      )
      .limit(1);

    if (!row?.externalPostingId) {
      /**
       * Nothing was ever live, so there is nothing to take down. Saying so is
       * better than queueing a call that would fail on an id we never had.
       */
      return {
        platform,
        status: "FAILED",
        message: "This board has no live posting for this job.",
        httpStatus: null,
      };
    }

    await OutboxWriter.emit(this.db, {
      eventId: randomUUID(),
      occurredAt: new Date(),
      organizationId: orgId,
      aggregateType: "job_board_posting",
      aggregateId: String(row.id),
      aggregateVersion: await nextAggregateVersion(this.db, {
        organizationId: orgId,
        aggregateType: "job_board_posting",
        aggregateId: String(row.id),
      }),
      eventType: BOARD_UNPUBLISH_REQUESTED,
      payload: { postingId: row.id, jobPostingId: jobId, platform },
    });

    return { platform, status: "QUEUED", postingId: row.id };
  }

  private async upsert(
    orgId: string,
    jobId: number,
    platform: string,
    values: Partial<typeof jobBoardPostings.$inferInsert>,
  ): Promise<number> {
    const [row] = await this.db
      .insert(jobBoardPostings)
      .values({ orgId, jobPostingId: jobId, platform, ...values })
      .onConflictDoUpdate({
        target: [jobBoardPostings.orgId, jobBoardPostings.jobPostingId, jobBoardPostings.platform],
        set: { ...values, updatedAt: sql`now()` },
      })
      .returning({ id: jobBoardPostings.id });
    return row!.id;
  }
}
