import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { organizations, organizationMembers } from "../common/auth";
import { kbSpaces } from "./spaces";

export const KB_RESEARCH_BRIEF_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
] as const;
export type KbResearchBriefStatus = (typeof KB_RESEARCH_BRIEF_STATUSES)[number];

export const kbResearchBriefs = pgTable(
  "kb_research_briefs",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userMembershipId: integer("user_membership_id").notNull(),
    topic: text("topic").notNull(),
    spaceId: integer("space_id"),
    status: text("status")
      .$type<KbResearchBriefStatus>()
      .notNull()
      .default("queued"),
    jobId: integer("job_id"),
    sourceCount: integer("source_count").notNull().default(0),
    report: text("report"),
    citations: jsonb("citations").$type<
      Array<{
        kind: string;
        id: number;
        title: string;
        href: string | null;
        updatedAt: string | null;
      }>
    >(),
    errorMessage: text("error_message"),
    rating: text("rating").$type<"helpful" | "not_helpful" | null>(),
    costCredits: integer("cost_credits"),
    provider: text("provider"),
    model: text("model"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByMembershipId: integer("approved_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_kb_research_briefs_org_mbr").on(
      table.orgId,
      table.userMembershipId,
    ),
    index("idx_kb_research_briefs_job").on(table.jobId),
    unique("uniq_kb_research_briefs_org_id").on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.spaceId],
      foreignColumns: [kbSpaces.orgId, kbSpaces.id],
      name: "fk_kb_research_briefs_org_space",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.orgId, table.userMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_kb_research_briefs_org_user_mbr",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId, table.approvedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_kb_research_briefs_approved_by",
    }).onDelete("set null"),
    index("idx_kb_research_briefs_approved_by").on(
      table.orgId,
      table.approvedByMembershipId,
    ),
  ],
);
