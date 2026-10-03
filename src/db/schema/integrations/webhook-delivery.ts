import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "../common/auth";
import { gitConnections } from "../build/git";

export const integrationGitConnectionCredentials = pgTable(
  "integration_git_connection_credentials",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    gitConnectionId: integer("git_connection_id").notNull(),
    signingSecret: text("signing_secret").notNull(),
    secretSetAt: timestamp("secret_set_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "fk_int_git_conn_cred_org_conn",
      columns: [t.orgId, t.gitConnectionId],
      foreignColumns: [gitConnections.orgId, gitConnections.id],
    }).onDelete("cascade"),
    index("idx_integration_git_conn_cred_org").on(t.orgId),
    uniqueIndex("uniq_integration_git_conn_cred_org_id").on(t.orgId, t.id),
    uniqueIndex("uniq_integration_git_conn_cred_org_conn").on(t.orgId, t.gitConnectionId),
  ],
);

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
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "fk_int_wh_deliveries_credential",
      columns: [t.orgId, t.credentialId],
      foreignColumns: [integrationWebhookEndpointCredentials.orgId, integrationWebhookEndpointCredentials.id],
    }).onDelete("set null"),
    index("idx_integration_webhook_deliveries_credential").on(t.orgId, t.credentialId),
    index("idx_integration_webhook_deliveries_build_webhook").on(t.orgId, t.buildWebhookId),
    index("idx_integration_webhook_deliveries_created_at").on(t.createdAt),
    unique("uniq_integration_webhook_deliveries_org_id").on(t.orgId, t.id),
    check(
      "chk_integration_webhook_deliveries_status",
      sql`${t.status} IN ('pending','success','failed')`,
    ),
  ],
);
