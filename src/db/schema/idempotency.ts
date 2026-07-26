import {
  pgTable,
  bigint,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./auth";
import { commandFenceStatusEnum } from "./enums";

/**
 * Persisted idempotency fence for sensitive mutating commands (plan §"Sensitive command
 * idempotency contract"). A record is keyed by (organization_id, audience, idempotency_key)
 * and stores a canonical request hash so a retry can be safely replayed, an in-flight duplicate
 * rejected (409), and a reused key with a different payload rejected (422).
 */
export const commandFences = pgTable(
  "command_fences",
  {
    commandFenceId: bigint("command_fence_id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    audience: text("audience").notNull().default("internal"),
    idempotencyKey: text("idempotency_key").notNull(),
    commandName: text("command_name").notNull(),
    requestHash: text("request_hash").notNull(),
    principalId: text("principal_id").notNull(),
    status: commandFenceStatusEnum("status").notNull().default("IN_FLIGHT"),
    responseBody: jsonb("response_body"),
    responseStatus: integer("response_status"),
    leaseExpiresAt: timestamp("lease_expires_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_command_fences_org_audience_key").on(
      table.organizationId,
      table.audience,
      table.idempotencyKey,
    ),
    index("idx_command_fences_expires").on(table.expiresAt),
  ],
);
