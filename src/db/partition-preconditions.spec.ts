import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema";

/**
 * c21-04 preconditions. Partitioning a table by `created_at` forces the partition key into every
 * PK and UNIQUE on it, and Postgres will only let a foreign key reference a unique constraint that
 * therefore now includes it. That makes two things expensive, and both are invisible until someone
 * writes the cutover migration:
 *
 *   - every inbound foreign key must denormalise the parent's `created_at` and reference the pair,
 *     or be dropped;
 *   - every unique constraint gains `created_at`, which WEAKENS it -- two rows that used to
 *     collide can now coexist in different partitions.
 *
 * The second is not theoretical for the outbox. `uniq_notification_outbox_dedupe` on
 * `(org_id, dedupe_key)` is the guarantee that "a retried request must not enqueue the same intent
 * twice". Add `created_at` and a retry that lands either side of a boundary enqueues twice.
 *
 * These tests pin the current shape so the cost of partitioning stays visible and cannot be
 * silently paid. They are preconditions, not a prohibition -- when the cutover happens, they are
 * the list of decisions it has to have made.
 */

const PARTITION_CANDIDATES = ["notifications", "chat_messages", "notification_outbox"] as const;

function tableByName(name: string): PgTable | undefined {
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    if (getTableConfig(value).name === name) return value;
  }
  return undefined;
}

function inboundForeignKeys(target: string): string[] {
  const inbound: string[] = [];
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const config = getTableConfig(value);
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      if (getTableConfig(ref.foreignTable).name !== target) continue;
      for (const column of ref.columns) inbound.push(`${config.name}.${column.name}`);
    }
  }
  return inbound.sort();
}

describe("c21-04 partition preconditions", () => {
  it("resolves all three candidate tables, so a typo cannot make this pass vacuously", () => {
    for (const name of PARTITION_CANDIDATES) expect(tableByName(name)).toBeDefined();
  });

  it("pins the inbound foreign keys each partition cutover would have to resolve", () => {
    expect(inboundForeignKeys("chat_messages")).toEqual([
      "chat_attachments.message_id",
      "chat_messages.reply_to_id",
      "chat_pinned_messages.message_id",
      "chat_reply_reminders.message_id",
      "chat_saved_messages.message_id",
    ]);

    expect(inboundForeignKeys("notifications")).toEqual([
      "notification_audit_logs.notification_id",
      "notification_deliveries.notification_id",
    ]);

    // The one candidate with nothing pointing at it, which is why it is the cheapest to partition
    // on the foreign-key axis and the most expensive on the uniqueness axis.
    expect(inboundForeignKeys("notification_outbox")).toEqual([]);
  });

  it("keeps outbox dedupe free of any time component, because partitioning would weaken it", () => {
    const outbox = tableByName("notification_outbox");
    expect(outbox).toBeDefined();
    const config = getTableConfig(outbox as PgTable);

    const dedupe = config.indexes.find((i) => i.config.name === "uniq_notification_outbox_dedupe");
    expect(dedupe).toBeDefined();
    expect(dedupe?.config.unique).toBe(true);

    const columns = (dedupe?.config.columns ?? []).map((c) => ("name" in c ? c.name : String(c)));
    expect(columns).toEqual(["org_id", "dedupe_key"]);
    expect(columns).not.toContain("created_at");
  });

  it("keeps every candidate's identity at bigint, since a partition cutover cannot also widen", () => {
    for (const name of PARTITION_CANDIDATES) {
      const table = tableByName(name);
      const config = getTableConfig(table as PgTable);
      const id = config.columns.find((c) => c.name === "id");
      expect(`${name}.id=${id?.getSQLType()}`).toBe(`${name}.id=bigint`);
    }
  });
});
