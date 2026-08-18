import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";

type WorkforceReadMode = "LEGACY" | "SHADOW" | "CANONICAL";
type WorkforceWriteMode = "LEGACY" | "DUAL" | "CANONICAL_WITH_PROJECTION";
type HistoryMode = "LEGACY" | "DUAL" | "EFFECTIVE";
type HierarchyReadMode = "ADJACENCY" | "SHADOW_CLOSURE" | "CLOSURE";
type HierarchyWriteMode = "LEGACY_ADAPTER" | "LOCKED_COMMAND";
type AttendanceReadMode = "LEGACY" | "SHADOW" | "EVENT";
type AttendanceWriteMode = "LEGACY" | "DUAL" | "EVENT_WITH_PROJECTION";
type LeaveReadMode = "LEGACY" | "SHADOW" | "LEDGER";
type LeaveWriteMode = "LEGACY" | "DUAL" | "LEDGER_WITH_PROJECTION";
type SensitiveReadMode = "LEGACY_ADAPTER" | "SHADOW_ENCRYPTED" | "ENCRYPTED";
type SensitiveWriteMode = "LEGACY" | "DUAL_ENCRYPTED" | "ENCRYPTED";

export type HrmsMigrationModes = {
  workforceReadMode: WorkforceReadMode;
  workforceWriteMode: WorkforceWriteMode;
  historyMode: HistoryMode;
  hierarchyReadMode: HierarchyReadMode;
  hierarchyWriteMode: HierarchyWriteMode;
  attendanceReadMode: AttendanceReadMode;
  attendanceWriteMode: AttendanceWriteMode;
  leaveReadMode: LeaveReadMode;
  leaveWriteMode: LeaveWriteMode;
  sensitiveReadMode: SensitiveReadMode;
  sensitiveWriteMode: SensitiveWriteMode;
};

export const hrmsMigrationProfiles = pgTable(
  "hrms_migration_profiles",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "restrict" }),
    workforceReadMode: text("workforce_read_mode")
      .$type<WorkforceReadMode>()
      .default("LEGACY")
      .notNull(),
    workforceWriteMode: text("workforce_write_mode")
      .$type<WorkforceWriteMode>()
      .default("LEGACY")
      .notNull(),
    historyMode: text("history_mode").$type<HistoryMode>().default("LEGACY").notNull(),
    hierarchyReadMode: text("hierarchy_read_mode")
      .$type<HierarchyReadMode>()
      .default("ADJACENCY")
      .notNull(),
    hierarchyWriteMode: text("hierarchy_write_mode")
      .$type<HierarchyWriteMode>()
      .default("LEGACY_ADAPTER")
      .notNull(),
    attendanceReadMode: text("attendance_read_mode")
      .$type<AttendanceReadMode>()
      .default("LEGACY")
      .notNull(),
    attendanceWriteMode: text("attendance_write_mode")
      .$type<AttendanceWriteMode>()
      .default("LEGACY")
      .notNull(),
    leaveReadMode: text("leave_read_mode")
      .$type<LeaveReadMode>()
      .default("LEGACY")
      .notNull(),
    leaveWriteMode: text("leave_write_mode")
      .$type<LeaveWriteMode>()
      .default("LEGACY")
      .notNull(),
    sensitiveReadMode: text("sensitive_read_mode")
      .$type<SensitiveReadMode>()
      .default("LEGACY_ADAPTER")
      .notNull(),
    sensitiveWriteMode: text("sensitive_write_mode")
      .$type<SensitiveWriteMode>()
      .default("LEGACY")
      .notNull(),
    minimumSensitiveAdapterVersion: integer("minimum_sensitive_adapter_version")
      .default(1)
      .notNull(),
    sensitivePlaintextWritesRetiredAt: timestamp(
      "sensitive_plaintext_writes_retired_at",
      { withTimezone: true },
    ),
    profileRevision: bigint("profile_revision", { mode: "number" })
      .default(1)
      .notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
    changedByPlatformUserId: text("changed_by_platform_user_id").references(
      () => users.id,
      { onDelete: "restrict" },
    ),
    changeTicket: text("change_ticket"),
    changeReason: text("change_reason"),
    rollbackDeadline: timestamp("rollback_deadline", { withTimezone: true }),
  },
  (table) => [
    check("chk_hrms_profile_revision", sql`${table.profileRevision} > 0`),
    check(
      "chk_hrms_profile_sensitive_adapter_version",
      sql`${table.minimumSensitiveAdapterVersion} > 0`,
    ),
    check(
      "chk_hrms_profile_workforce_modes",
      sql`(${table.workforceReadMode}, ${table.workforceWriteMode}) IN (('LEGACY', 'LEGACY'), ('LEGACY', 'DUAL'), ('SHADOW', 'DUAL'), ('CANONICAL', 'CANONICAL_WITH_PROJECTION'))`,
    ),
    check(
      "chk_hrms_profile_history_mode",
      sql`${table.historyMode} IN ('LEGACY', 'DUAL', 'EFFECTIVE')`,
    ),
    check(
      "chk_hrms_profile_hierarchy_modes",
      sql`(${table.hierarchyReadMode}, ${table.hierarchyWriteMode}) IN (('ADJACENCY', 'LEGACY_ADAPTER'), ('SHADOW_CLOSURE', 'LOCKED_COMMAND'), ('CLOSURE', 'LOCKED_COMMAND'))`,
    ),
    check(
      "chk_hrms_profile_attendance_modes",
      sql`(${table.attendanceReadMode}, ${table.attendanceWriteMode}) IN (('LEGACY', 'LEGACY'), ('LEGACY', 'DUAL'), ('SHADOW', 'DUAL'), ('EVENT', 'EVENT_WITH_PROJECTION'))`,
    ),
    check(
      "chk_hrms_profile_leave_modes",
      sql`(${table.leaveReadMode}, ${table.leaveWriteMode}) IN (('LEGACY', 'LEGACY'), ('LEGACY', 'DUAL'), ('SHADOW', 'DUAL'), ('LEDGER', 'LEDGER_WITH_PROJECTION'))`,
    ),
    check(
      "chk_hrms_profile_sensitive_modes",
      sql`(${table.sensitiveReadMode}, ${table.sensitiveWriteMode}) IN (('LEGACY_ADAPTER', 'LEGACY'), ('LEGACY_ADAPTER', 'DUAL_ENCRYPTED'), ('SHADOW_ENCRYPTED', 'DUAL_ENCRYPTED'), ('ENCRYPTED', 'ENCRYPTED'), ('SHADOW_ENCRYPTED', 'ENCRYPTED'), ('LEGACY_ADAPTER', 'ENCRYPTED'))`,
    ),
    check(
      "chk_hrms_profile_sensitive_retirement",
      sql`(${table.sensitiveWriteMode} = 'LEGACY') = (${table.sensitivePlaintextWritesRetiredAt} IS NULL)`,
    ),
    check(
      "chk_hrms_profile_change_metadata",
      sql`(${table.changeTicket} IS NULL OR btrim(${table.changeTicket}) <> '') AND (${table.changeReason} IS NULL OR btrim(${table.changeReason}) <> '') AND (${table.profileRevision} = 1 OR (${table.changedByPlatformUserId} IS NOT NULL AND ${table.changeTicket} IS NOT NULL AND ${table.changeReason} IS NOT NULL))`,
    ),
    check(
      "chk_hrms_profile_initial_state",
      sql`${table.profileRevision} <> 1 OR (${table.workforceReadMode} = 'LEGACY' AND ${table.workforceWriteMode} = 'LEGACY' AND ${table.historyMode} = 'LEGACY' AND ${table.hierarchyReadMode} = 'ADJACENCY' AND ${table.hierarchyWriteMode} = 'LEGACY_ADAPTER' AND ${table.attendanceReadMode} = 'LEGACY' AND ${table.attendanceWriteMode} = 'LEGACY' AND ${table.leaveReadMode} = 'LEGACY' AND ${table.leaveWriteMode} = 'LEGACY' AND ${table.sensitiveReadMode} = 'LEGACY_ADAPTER' AND ${table.sensitiveWriteMode} = 'LEGACY' AND ${table.sensitivePlaintextWritesRetiredAt} IS NULL)`,
    ),
    index("idx_hrms_profiles_changed_actor").on(table.changedByPlatformUserId),
  ],
);

export const hrmsMigrationProfileEvents = pgTable(
  "hrms_migration_profile_events",
  {
    organizationId: text("organization_id")
      .references(() => hrmsMigrationProfiles.organizationId, { onDelete: "restrict" })
      .notNull(),
    profileRevision: bigint("profile_revision", { mode: "number" }).notNull(),
    beforeModes: jsonb("before_modes").$type<HrmsMigrationModes>().notNull(),
    afterModes: jsonb("after_modes").$type<HrmsMigrationModes>().notNull(),
    manifestHash: text("manifest_hash").notNull(),
    proposedByPlatformUserId: text("proposed_by_platform_user_id").notNull(),
    approvedByPlatformUserId: text("approved_by_platform_user_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.profileRevision],
      name: "pk_hrms_migration_profile_events",
    }),
    check(
      "chk_hrms_profile_events_revision",
      sql`${table.profileRevision} > 1`,
    ),
    check(
      "chk_hrms_profile_events_distinct_actors",
      sql`${table.proposedByPlatformUserId} <> ${table.approvedByPlatformUserId}`,
    ),
    check(
      "chk_hrms_profile_events_actor_snapshots",
      sql`btrim(${table.proposedByPlatformUserId}) <> '' AND btrim(${table.approvedByPlatformUserId}) <> ''`,
    ),
    check(
      "chk_hrms_profile_events_manifest_hash",
      sql`btrim(${table.manifestHash}) <> ''`,
    ),
    check(
      "chk_hrms_profile_events_before_modes",
      sql`app.hrms_modes_valid(${table.beforeModes})`,
    ),
    check(
      "chk_hrms_profile_events_after_modes",
      sql`app.hrms_modes_valid(${table.afterModes})`,
    ),
    index("idx_hrms_profile_events_org_time").on(
      table.organizationId,
      table.occurredAt,
    ),
  ],
);

export const hrmsScopeVersions = pgTable(
  "hrms_scope_versions",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "restrict" }),
    scopeRevision: bigint("scope_revision", { mode: "number" }).default(1).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("chk_hrms_scope_revision", sql`${table.scopeRevision} > 0`),
  ],
);
