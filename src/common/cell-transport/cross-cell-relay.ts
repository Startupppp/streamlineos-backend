import Ably from "ably";
import type { Sql } from "postgres";
import {
  assertMayCrossCells,
  CrossCellEventRefusedError,
} from "../region/cross-cell-events";
import type { CrossCellEventType } from "../region/cross-cell-events";
import { cellPrefixed } from "./cell-channel-namespace";

const DEAD_LETTER_TABLE = "cell_relay_dead_letters";
const RELAY_CHANNEL_INFIX = "cell-relay";

export type RelayOutcome =
  | {
      readonly status: "delivered";
      readonly eventType: CrossCellEventType;
      readonly channel: string;
    }
  | {
      readonly status: "refused";
      readonly eventType: string;
      readonly reason: string;
      readonly deadLettered: boolean;
    }
  | {
      readonly status: "failed";
      readonly eventType: string;
      readonly error: string;
      readonly deadLettered: boolean;
    };

export class CrossCellRelay {
  private readonly rest: Ably.Rest;

  constructor(
    private readonly sourceCellId: string,
    ablyApiKey: string,
    private readonly db: Sql,
  ) {
    this.rest = new Ably.Rest(ablyApiKey);
  }

  async ensureDeadLetterTable(): Promise<void> {
    await this.db.unsafe(`
      CREATE TABLE IF NOT EXISTS ${DEAD_LETTER_TABLE} (
        id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        source_cell_id TEXT        NOT NULL,
        event_type     TEXT        NOT NULL,
        payload        JSONB       NOT NULL,
        reason         TEXT        NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async dropDeadLetterTable(): Promise<void> {
    await this.db.unsafe(`DROP TABLE IF EXISTS ${DEAD_LETTER_TABLE}`);
  }

  async countDeadLetters(): Promise<number> {
    const rows = await this.db<{ n: string }[]>`
      SELECT count(*) AS n FROM ${this.db(DEAD_LETTER_TABLE)}
    `;
    const first = rows[0];
    return first !== undefined ? Number(first.n) : 0;
  }

  private async writeDeadLetter(
    eventType: string,
    payload: unknown,
    reason: string,
  ): Promise<boolean> {
    try {
      const payloadStr = JSON.stringify(payload) ?? "null";
      await this.db`
        INSERT INTO ${this.db(DEAD_LETTER_TABLE)}
          (source_cell_id, event_type, payload, reason)
        VALUES (
          ${this.sourceCellId},
          ${eventType},
          ${payloadStr}::jsonb,
          ${reason}
        )
      `;
      return true;
    } catch {
      return false;
    }
  }

  async relay(eventType: string, payload: unknown): Promise<RelayOutcome> {
    let checkedType: CrossCellEventType;
    try {
      checkedType = assertMayCrossCells(eventType);
    } catch (err: unknown) {
      const reason =
        err instanceof CrossCellEventRefusedError ? err.message : String(err);
      const deadLettered = await this.writeDeadLetter(eventType, payload, reason);
      return { status: "refused", eventType, reason, deadLettered };
    }

    const channel = cellPrefixed(
      this.sourceCellId,
      `${RELAY_CHANNEL_INFIX}:${checkedType}`,
    );
    try {
      await this.rest.channels.get(channel).publish(checkedType, payload);
      return { status: "delivered", eventType: checkedType, channel };
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      const deadLettered = await this.writeDeadLetter(
        eventType,
        payload,
        `delivery failed: ${error}`,
      );
      return { status: "failed", eventType, error, deadLettered };
    }
  }
}
