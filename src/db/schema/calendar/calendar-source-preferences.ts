import {
  pgTable,
  bigint,
  integer,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { organizations, users, organizationMembers } from "../common/auth";

export const calendarSourcePreferences = pgTable(
  "calendar_source_preferences",
  {
    preferenceId: bigint("preference_id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    membershipId: integer("membership_id"),
    sourceKey: text("source_key").notNull(),
    enabled: boolean("enabled").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_cal_src_pref_org_user_key").on(
      table.orgId,
      table.userId,
      table.sourceKey,
    ),
    uniqueIndex("uniq_cal_src_pref_org_membership_key").on(
      table.orgId,
      table.membershipId,
      table.sourceKey,
    ),
    index("idx_cal_src_pref_org_user").on(table.orgId, table.userId),
    index("idx_cal_src_pref_org_membership").on(table.orgId, table.membershipId),
    foreignKey({
      columns: [table.orgId, table.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_cal_src_pref_org_membership",
    }).onDelete("set null"),
  ],
);
