import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { workerEngagementStatusEnum } from "../common/enums";
import { workerEngagements } from "./worker-engagements";

type WorkerEngagementEventKind =
  | "LEGACY_SNAPSHOT"
  | "ENGAGEMENT_CREATED"
  | "STATUS_CHANGED";

export const workerEngagementStateEvents = pgTable(
  "worker_engagement_state_events",
  {
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "restrict" })
      .notNull(),
    eventId: bigint("event_id", { mode: "bigint" })
      .generatedAlwaysAsIdentity()
      .notNull(),
    workerEngagementId: text("worker_engagement_id").notNull(),
    eventKind: text("event_kind").$type<WorkerEngagementEventKind>().notNull(),
    fromStatus: workerEngagementStatusEnum("from_status"),
    toStatus: workerEngagementStatusEnum("to_status").notNull(),
    effectiveDate: date("effective_date").notNull(),
    reasonCode: text("reason_code").notNull(),
    commandScope: text("command_scope").notNull(),
    commandId: text("command_id").notNull(),
    effectOrdinal: integer("effect_ordinal").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    sourceOrdinal: integer("source_ordinal").notNull(),
    commandFenceId: bigint("command_fence_id", { mode: "bigint" }),
    migrationBatchId: text("migration_batch_id"),
    actorMembershipId: integer("actor_membership_id"),
    actorUserId: text("actor_user_id"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.eventId],
      name: "pk_worker_engagement_state_events",
    }),
    unique("uniq_worker_engagement_state_events_projection").on(
      table.organizationId,
      table.eventId,
      table.workerEngagementId,
      table.toStatus,
    ),
    unique("uniq_worker_engagement_state_events_command").on(
      table.organizationId,
      table.commandScope,
      table.commandId,
      table.effectOrdinal,
    ),
    unique("uniq_worker_engagement_state_events_source").on(
      table.organizationId,
      table.sourceType,
      table.sourceId,
      table.sourceOrdinal,
    ),
    uniqueIndex("uniq_worker_engagement_state_events_legacy_snapshot")
      .on(table.organizationId, table.workerEngagementId, table.eventKind)
      .where(sql`${table.eventKind} = 'LEGACY_SNAPSHOT'`),
    index("idx_worker_engagement_state_events_engagement").on(
      table.organizationId,
      table.workerEngagementId,
      table.effectiveDate,
      table.eventId,
    ),
    index("idx_worker_engagement_state_events_fence").on(table.commandFenceId),
    index("idx_worker_engagement_state_events_actor").on(
      table.organizationId,
      table.actorMembershipId,
    ),
    foreignKey({
      columns: [table.organizationId, table.workerEngagementId],
      foreignColumns: [
        workerEngagements.organizationId,
        workerEngagements.workerEngagementId,
      ],
      name: "fk_worker_engagement_state_events_engagement",
    }).onDelete("restrict"),
    check(
      "chk_worker_engagement_state_events_ordinals",
      sql`${table.effectOrdinal} >= 0 AND ${table.sourceOrdinal} >= 0`,
    ),
    check(
      "chk_worker_engagement_state_events_snapshots",
      sql`(${table.commandFenceId} IS NULL OR ${table.commandFenceId} > 0) AND (${table.actorMembershipId} IS NULL OR ${table.actorMembershipId} > 0) AND (${table.actorUserId} IS NULL OR btrim(${table.actorUserId}) <> '')`,
    ),
    check(
      "chk_worker_engagement_state_events_nonblank_keys",
      sql`btrim(${table.commandScope}) <> '' AND btrim(${table.commandId}) <> '' AND btrim(${table.sourceType}) <> '' AND btrim(${table.sourceId}) <> '' AND btrim(${table.reasonCode}) <> ''`,
    ),
    check(
      "chk_worker_engagement_state_events_kind",
      sql`${table.eventKind} IN ('LEGACY_SNAPSHOT', 'ENGAGEMENT_CREATED', 'STATUS_CHANGED')`,
    ),
    check(
      "chk_worker_engagement_state_events_transition",
      sql`(${table.eventKind} = 'LEGACY_SNAPSHOT' AND ${table.fromStatus} IS NULL) OR (${table.eventKind} = 'ENGAGEMENT_CREATED' AND ${table.fromStatus} IS NULL AND ${table.toStatus} IN ('PLANNED', 'ACTIVE')) OR (${table.eventKind} = 'STATUS_CHANGED' AND ((${table.fromStatus} = 'PLANNED' AND ${table.toStatus} IN ('ACTIVE', 'CANCELLED')) OR (${table.fromStatus} = 'ACTIVE' AND ${table.toStatus} IN ('COMPLETED', 'TERMINATED'))))`,
    ),
    check(
      "chk_worker_engagement_state_events_legacy_batch",
      sql`(${table.migrationBatchId} IS NULL OR btrim(${table.migrationBatchId}) <> '') AND (${table.eventKind} <> 'LEGACY_SNAPSHOT' OR ${table.migrationBatchId} IS NOT NULL)`,
    ),
  ],
);
