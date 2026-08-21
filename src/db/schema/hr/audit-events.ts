import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

export const hrAuditEventSources = pgTable(
  "hr_audit_event_sources",
  {
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "restrict" })
      .notNull(),
    auditEventId: bigint("audit_event_id", { mode: "bigint" })
      .generatedAlwaysAsIdentity()
      .notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    sourceOrdinal: integer("source_ordinal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "pk_hr_audit_event_sources",
      columns: [table.organizationId, table.auditEventId],
    }),
    unique("uniq_hr_audit_event_sources_event_time").on(
      table.organizationId,
      table.auditEventId,
      table.occurredAt,
    ),
    unique("uniq_hr_audit_event_sources_source").on(
      table.organizationId,
      table.sourceType,
      table.sourceId,
      table.sourceOrdinal,
    ),
    check(
      "chk_hr_audit_event_sources_key",
      sql`btrim(${table.sourceType}) <> '' AND btrim(${table.sourceId}) <> '' AND ${table.sourceOrdinal} >= 0`,
    ),
    index("idx_hr_audit_event_sources_org_time").on(
      table.organizationId,
      table.occurredAt,
    ),
  ],
);

export const hrAuditEvents = pgTable(
  "hr_audit_events",
  {
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "restrict" })
      .notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    auditEventId: bigint("audit_event_id", { mode: "bigint" }).notNull(),
    actorUserId: text("actor_user_id"),
    actorMembershipId: integer("actor_membership_id"),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    requestId: text("request_id"),
    correlationId: text("correlation_id"),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    sourceOrdinal: integer("source_ordinal").notNull(),
    migrationBatchId: text("migration_batch_id"),
    redactedDiff: jsonb("redacted_diff")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "pk_hr_audit_events",
      columns: [table.organizationId, table.occurredAt, table.auditEventId],
    }),
    unique("uniq_hr_audit_events_source").on(
      table.organizationId,
      table.occurredAt,
      table.sourceType,
      table.sourceId,
      table.sourceOrdinal,
    ),
    foreignKey({
      name: "fk_hr_audit_events_source",
      columns: [table.organizationId, table.auditEventId, table.occurredAt],
      foreignColumns: [
        hrAuditEventSources.organizationId,
        hrAuditEventSources.auditEventId,
        hrAuditEventSources.occurredAt,
      ],
    }).onDelete("restrict"),
    check(
      "chk_hr_audit_events_source_ordinal_nonnegative",
      sql`${table.sourceOrdinal} >= 0`,
    ),
    check(
      "chk_hr_audit_events_required_text",
      sql`btrim(${table.entityType}) <> '' AND btrim(${table.entityId}) <> '' AND btrim(${table.action}) <> '' AND btrim(${table.sourceType}) <> '' AND btrim(${table.sourceId}) <> ''`,
    ),
    check(
      "chk_hr_audit_events_optional_text",
      sql`(${table.requestId} IS NULL OR btrim(${table.requestId}) <> '') AND (${table.correlationId} IS NULL OR btrim(${table.correlationId}) <> '') AND (${table.migrationBatchId} IS NULL OR btrim(${table.migrationBatchId}) <> '')`,
    ),
    check(
      "chk_hr_audit_events_redacted_diff_object",
      sql`jsonb_typeof(${table.redactedDiff}) = 'object'`,
    ),
    index("idx_hr_audit_events_org_entity_time").on(
      table.organizationId,
      table.entityType,
      table.entityId,
      table.occurredAt,
    ),
    index("idx_hr_audit_events_org_actor_time").on(
      table.organizationId,
      table.actorMembershipId,
      table.occurredAt,
    ),
    index("idx_hr_audit_events_org_correlation").on(
      table.organizationId,
      table.correlationId,
    ),
  ],
);
