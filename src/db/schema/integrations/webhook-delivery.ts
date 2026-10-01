import {
  bigserial,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "../common/auth";

export const integrationWebhookEndpointCredentials = pgTable(
  "integration_webhook_endpoint_credentials",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    buildWebhookId: integer("build_webhook_id"),
    signingSecret: text("signing_secret").notNull(),
    secretSetAt: timestamp("secret_set_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_integration_webhook_creds_org").on(t.orgId),
    index("idx_integration_webhook_creds_org_build_webhook").on(t.orgId, t.buildWebhookId),
    unique("uniq_integration_webhook_creds_org_id").on(t.orgId, t.id),
  ],
);

export const integrationWebhookDeliveries = pgTable(
  "integration_webhook_deliveries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    credentialId: integer("credential_id"),
    buildWebhookId: integer("build_webhook_id"),
    targetUrl: text("target_url").notNull(),
    event: varchar("event", { length: 100 }).notNull(),
    payload: jsonb("payload"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    responseCode: integer("response_code"),
    responseBody: text("response_body"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "fk_int_wh_deliveries_credential",
      columns: [t.credentialId],
      foreignColumns: [integrationWebhookEndpointCredentials.id],
    }).onDelete("set null"),
    index("idx_integration_webhook_deliveries_credential").on(t.orgId, t.credentialId),
    index("idx_integration_webhook_deliveries_build_webhook").on(t.orgId, t.buildWebhookId),
    index("idx_integration_webhook_deliveries_delivered_at").on(t.deliveredAt),
    unique("uniq_integration_webhook_deliveries_org_id").on(t.orgId, t.id),
    check(
      "chk_integration_webhook_deliveries_status",
      sql`${t.status} IN ('pending','success','failed')`,
    ),
  ],
);
