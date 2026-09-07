/**
 * The half no mocked spec can reach: does the outbox retention sweep prune anything?
 *
 * `CronOutboxRetentionService.sweepOrg` builds its batch deletes from raw
 * subselects, and those subselects named `org_id` on `outbox_events` and
 * `inbox_records` — two tables whose tenant column is `organization_id`. Every
 * tenant therefore raised `42703 column "org_id" does not exist`,
 * `forEachOrg` swallowed the throw per organisation and carried on, `sweep()`
 * returned `{outboxEventsDeleted: 0, inboxRecordsDeleted: 0}` and
 * `cron-outbox.controller` answered 200 with "0 outbox events and 0 inbox
 * records deleted" — indistinguishable from a quiet night. `OUTBOX_RETENTION_DAYS
 * = 30` was declared and never applied; both tables grow forever holding event
 * payloads past the stated window.
 *
 * A mocked db proves nothing here. It answers whatever it was told, and the
 * failure is a catalog fact — the column simply is not there. So this spec is an
 * ANTI-VACUITY FLOOR: it seeds rows that are unambiguously eligible and asserts a
 * NON-ZERO delete count. Asserting "does not throw" would pass against the
 * defect, because the throw is caught one frame above.
 *
 * The hermetic half is in `outbox-retention-sweep.spec.ts`. Everything here
 * happens inside a transaction that is rolled back, fixtures included, so the
 * database is left as it was found.
 *
 *   DATABASE_URL=postgresql://…/scratch_head_1010 PGSSLMODE=disable \
 *     node ./node_modules/jest/bin/jest.js --config ./jest-db.json --runInBand \
 *       --testPathPattern="outbox-retention-sweep.db"
 */
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.types";
import {
  OUTBOX_RETENTION_DAYS,
  sweepOrgOutboxRetention,
  type OrgRetentionOutcome,
} from "../cron-outbox-retention.service";

jest.setTimeout(120_000);

class Rollback extends Error {}

function connect(): ReturnType<typeof postgres> {
  if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required to run this suite");
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const plaintext =
    process.env.PGSSLMODE === "disable" ||
    url.searchParams.get("sslmode") === "disable" ||
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1";
  return postgres(url.toString(), {
    prepare: false,
    max: 1,
    ssl: plaintext ? false : "require",
    connect_timeout: 30,
    onnotice: () => {},
  });
}

const AGE_DAYS = OUTBOX_RETENTION_DAYS + 45;
const OUTBOX_ELIGIBLE = 4;
const INBOX_ELIGIBLE = 3;

describe("outbox retention sweep — real database", () => {
  let client: ReturnType<typeof postgres>;

  beforeAll(() => {
    client = connect();
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  it("prunes eligible outbox_events and inbox_records for the tenant", async () => {
    const db: Db = drizzle(client, { schema });
    const orgId = `outbox-ret-${randomUUID().slice(0, 12)}`;
    const cutoff = new Date(Date.now() - OUTBOX_RETENTION_DAYS * 86_400_000);
    const old = new Date(Date.now() - AGE_DAYS * 86_400_000).toISOString();
    const fresh = new Date().toISOString();

    let outcome: OrgRetentionOutcome | null = null;
    let survivors: { outbox: number; inbox: number } | null = null;

    await db
      .transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO organizations (id, name, slug, owner_membership_id)
          VALUES (${orgId}, ${"Outbox Retention Probe"}, ${orgId}, 0)
        `);

        for (let i = 0; i < OUTBOX_ELIGIBLE; i++)
          await tx.execute(sql`
            INSERT INTO outbox_events
              (event_id, organization_id, aggregate_type, aggregate_id, aggregate_version,
               delivery_state, event_type, payload, occurred_at)
            VALUES (${`${orgId}-old-${String(i)}`}, ${orgId}, ${"probe"}, ${`agg-${String(i)}`},
                    ${i + 1}, ${"DELIVERED"}, ${"probe.event"}, ${sql`'{}'::jsonb`}, ${old}::timestamptz)
          `);

        await tx.execute(sql`
          INSERT INTO outbox_events
            (event_id, organization_id, aggregate_type, aggregate_id, aggregate_version,
             delivery_state, event_type, payload, occurred_at)
          VALUES (${`${orgId}-fresh`}, ${orgId}, ${"probe"}, ${"agg-fresh"}, ${900},
                  ${"DELIVERED"}, ${"probe.event"}, ${sql`'{}'::jsonb`}, ${fresh}::timestamptz),
                 (${`${orgId}-pending`}, ${orgId}, ${"probe"}, ${"agg-pending"}, ${901},
                  ${"PENDING"}, ${"probe.event"}, ${sql`'{}'::jsonb`}, ${old}::timestamptz)
        `);

        for (let i = 0; i < INBOX_ELIGIBLE; i++)
          await tx.execute(sql`
            INSERT INTO inbox_records
              (producer_event_id, consumer_name, organization_id, aggregate_version, status, processed_at)
            VALUES (${`${orgId}-in-old-${String(i)}`}, ${"probe-consumer"}, ${orgId},
                    ${i + 1}, ${"PROCESSED"}, ${old}::timestamptz)
          `);

        await tx.execute(sql`
          INSERT INTO inbox_records
            (producer_event_id, consumer_name, organization_id, aggregate_version, status, processed_at)
          VALUES (${`${orgId}-in-fresh`}, ${"probe-consumer"}, ${orgId}, ${900}, ${"PROCESSED"}, ${fresh}::timestamptz),
                 (${`${orgId}-in-pending`}, ${"probe-consumer"}, ${orgId}, ${901}, ${"PENDING"}, ${null})
        `);

        outcome = await sweepOrgOutboxRetention(tx, orgId, cutoff);

        const outboxLeft = await tx.execute(sql`
          SELECT count(*)::int AS n FROM outbox_events WHERE organization_id = ${orgId}
        `);
        const inboxLeft = await tx.execute(sql`
          SELECT count(*)::int AS n FROM inbox_records WHERE organization_id = ${orgId}
        `);
        survivors = {
          outbox: Number(outboxLeft[0]?.["n"] ?? -1),
          inbox: Number(inboxLeft[0]?.["n"] ?? -1),
        };

        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });

    expect(outcome).not.toBeNull();
    expect(outcome).toEqual({
      outboxDeleted: OUTBOX_ELIGIBLE,
      inboxDeleted: INBOX_ELIGIBLE,
      truncated: false,
    });
    expect(survivors).toEqual({ outbox: 2, inbox: 2 });
  });
});
