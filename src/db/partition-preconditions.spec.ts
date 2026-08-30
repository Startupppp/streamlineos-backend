import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema";

// notifications is partitioned (0582); chat_messages and the outbox are not, and this pins why.

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

  it("pins the inbound foreign keys a chat_messages cutover would have to resolve", () => {
    expect(inboundForeignKeys("chat_messages")).toEqual([
      "chat_attachments.message_id",
      "chat_attachments.message_id",
      "chat_attachments.org_id",
      "chat_message_reactions.message_id",
      "chat_message_reactions.org_id",
      "chat_messages.org_id",
      "chat_messages.reply_to_id",
      "chat_messages.reply_to_id",
      "chat_pinned_messages.message_id",
      "chat_pinned_messages.message_id",
      "chat_pinned_messages.org_id",
      "chat_reply_reminders.message_id",
      "chat_reply_reminders.message_id",
      "chat_reply_reminders.org_id",
      "chat_saved_messages.message_id",
      "chat_saved_messages.message_id",
      "chat_saved_messages.org_id",
    ]);
  });

  it("has both notifications children referencing the composite key, not the bare id", () => {
    expect(inboundForeignKeys("notifications")).toEqual([
      "notification_audit_logs.notification_created_at",
      "notification_audit_logs.notification_id",
      "notification_deliveries.notification_created_at",
      "notification_deliveries.notification_id",
    ]);
  });

  it("keeps the outbox free of inbound foreign keys", () => {
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

  it("declares notifications' primary key as the partition-key pair", () => {
    const config = getTableConfig(tableByName("notifications") as PgTable);
    const pk = config.primaryKeys.find((k) => k.getName() === "notifications_pkey");
    expect(pk).toBeDefined();
    expect((pk?.columns ?? []).map((c) => c.name)).toEqual(["id", "created_at"]);

    const orgUnique = config.uniqueConstraints.find(
      (u) => u.name === "uniq_notifications_org_id",
    );
    expect((orgUnique?.columns ?? []).map((c) => c.name)).toEqual(["org_id", "id", "created_at"]);
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
