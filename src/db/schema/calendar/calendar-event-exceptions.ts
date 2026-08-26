import {
  pgTable,
  bigint,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { calendarEvents } from "../common/shared";

export const calendarEventExceptions = pgTable(
  "calendar_event_exceptions",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    eventId: integer("event_id")
      .references(() => calendarEvents.id, { onDelete: "cascade" })
      .notNull(),
    occurrenceStart: timestamp("occurrence_start", { withTimezone: true }).notNull(),
    isCancelled: boolean("is_cancelled").notNull().default(false),
    modifiedTitle: text("modified_title"),
    modifiedStart: timestamp("modified_start", { withTimezone: true }),
    modifiedEnd: timestamp("modified_end", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_cal_exc_org_event_occ").on(
      table.orgId,
      table.eventId,
      table.occurrenceStart,
    ),
    index("idx_cal_exc_org_event").on(table.orgId, table.eventId),
  ],
);
