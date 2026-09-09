import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { outboxEvents } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../tenant";
import type { TenantTx } from "../tenant";

export const OUTBOX_REPLAY_BATCH = 100;

export interface OutboxReplayOptions {
  eventType?: string;
  organizationId?: string;
}

export interface OutboxReplayResult {
  organizationsProcessed: number;
  organizationsFailed: number;
  replayed: number;
  truncated: boolean;
}

/**
 * Resets one tenant's dead-lettered events for another delivery attempt.
 *
 * `last_error` is deliberately kept: it is the only record of why the event died, and the
 * operator draining the queue needs it to tell a replay that will work from one that will
 * dead-letter again on the same provider outage.
 */
export async function replayOrgDeadLetters(
  tx: TenantTx,
  organizationId: string,
  eventType?: string,
): Promise<number> {
  const rows = await tx
    .update(outboxEvents)
    .set({
      deliveryState: "PENDING",
      retryCount: 0,
      leaseExpiresAt: null,
      deadLetteredAt: null,
    })
    .where(
      sql`${outboxEvents.outboxEventId} in (
        select ${outboxEvents.outboxEventId} from ${outboxEvents}
        where ${and(
          eq(outboxEvents.organizationId, organizationId),
          eq(outboxEvents.deliveryState, "DEAD"),
          eventType === undefined ? undefined : eq(outboxEvents.eventType, eventType),
        )}
        order by ${outboxEvents.outboxEventId}
        limit ${OUTBOX_REPLAY_BATCH}
      )`,
    )
    .returning({ id: outboxEvents.outboxEventId });

  return rows.length;
}

@Injectable()
export class OutboxReplayService {
  private readonly logger = new Logger(OutboxReplayService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async replayDeadLetters(options: OutboxReplayOptions = {}): Promise<OutboxReplayResult> {
    let replayed = 0;
    let truncated = false;

    const outcome = await forEachOrg(this.db, "outbox-events-replay-dead", async (tx, orgId) => {
      if (options.organizationId !== undefined && options.organizationId !== orgId) return;
      const count = await replayOrgDeadLetters(tx, orgId, options.eventType);
      replayed += count;
      if (count >= OUTBOX_REPLAY_BATCH) truncated = true;
    });

    this.logger.log(
      `[outbox-replay] requeued ${replayed} dead-lettered event(s) ` +
        `eventType=${options.eventType ?? "*"} organizationId=${options.organizationId ?? "*"} ` +
        `truncated=${truncated}`,
    );

    return {
      organizationsProcessed: outcome.succeeded,
      organizationsFailed: outcome.failed,
      replayed,
      truncated,
    };
  }
}
