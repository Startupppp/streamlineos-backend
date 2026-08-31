import { pgTable, serial, text, varchar, integer, jsonb, timestamp, index, unique, foreignKey } from "drizzle-orm/pg-core";
import { organizations, users, organizationMembers } from "../common/auth";

interface SummaryStructured {
  highlights: string[];
  blockers: string[];
  nextActions: string[];
}

interface SummaryCitation {
  id: string | number;
  title: string;
  href?: string;
  snippet?: string;
  freshness?: string;
}

export const aiSummarySnapshots = pgTable(
  "ai_summary_snapshots",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    entityType: varchar("entity_type", { length: 50 }).notNull(),
    entityId: varchar("entity_id", { length: 100 }).notNull(),
    summary: text("summary").notNull(),
    structured: jsonb("structured").$type<SummaryStructured>(),
    citations: jsonb("citations").$type<SummaryCitation[]>(),
    correlationId: varchar("correlation_id", { length: 64 }),
    generatedBy: text("generated_by").references(() => users.id, { onDelete: "set null" }),
    generatedByMembershipId: integer("generated_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_ai_summary_snapshots_org_type_entity_created").on(
      table.orgId,
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
    unique("uniq_ai_summary_snapshots_org_id").on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.generatedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_ai_summary_org_gen_mbr",
    }).onDelete("set null"),
  ],
);

export type AiSummarySnapshot = typeof aiSummarySnapshots.$inferSelect;
