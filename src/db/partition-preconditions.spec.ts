import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema";

// Partitioning forces created_at into every PK/UNIQUE: inbound FKs must carry it, and uniqueness weakens.

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
