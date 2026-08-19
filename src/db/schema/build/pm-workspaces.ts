import { text, boolean, timestamp, index, unique, uniqueIndex, check } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { organizations } from "../common/auth";

/**
 * PM Workspace — the Product Management collaboration/access container inside an Organization
 * (Organization → Product Management → PM Workspace → Managed Product / Delivery Team / Project).
 * Never the tenant. Exactly one default per eligible Organization (partial unique on is_default).
 */
export const pmWorkspaces = build.table(
  "pm_workspaces",
  {
    pmWorkspaceId: text("pm_workspace_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    status: text("status")
      .$type<"active" | "archived">()
      .default("active")
      .notNull(),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Candidate key (constraint, so it can be a composite-FK target for PM children).
    unique("uniq_pm_workspaces_org_workspace").on(t.orgId, t.pmWorkspaceId),
    // At most one default PM Workspace per Organization.
    uniqueIndex("uniq_pm_workspaces_org_default")
      .on(t.orgId)
      .where(sql`is_default = true`),
    uniqueIndex("uniq_pm_workspaces_org_slug").on(t.orgId, t.slug),
    index("idx_pm_workspaces_org").on(t.orgId).where(sql`deleted_at IS NULL`),
    check("chk_pm_workspaces_status", sql`${t.status} IN ('active','archived')`),
  ],
);
