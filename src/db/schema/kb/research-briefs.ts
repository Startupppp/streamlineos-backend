import { pgTable, serial, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { organizations, users } from "../auth";

export const KB_RESEARCH_BRIEF_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type KbResearchBriefStatus = (typeof KB_RESEARCH_BRIEF_STATUSES)[number];

export const kbResearchBriefs = pgTable(
  "kb_research_briefs",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    topic: text("topic").notNull(),
    spaceId: integer("space_id"),
    status: text("status").$type<KbResearchBriefStatus>().notNull().default("queued"),
    jobId: integer("job_id"),
    sourceCount: integer("source_count").notNull().default(0),
    report: text("report"),
    citations: jsonb("citations").$type<Array<{ kind: string; id: number; title: string; href: string | null; updatedAt: string | null }>>(),
    errorMessage: text("error_message"),
    rating: text("rating").$type<"helpful" | "not_helpful" | null>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_kb_research_briefs_org").on(table.orgId),
    index("idx_kb_research_briefs_org_user").on(table.orgId, table.userId),
    index("idx_kb_research_briefs_job").on(table.jobId),
  ],
);
