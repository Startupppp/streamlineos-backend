import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/**
 * Whether this organisation lets agents drive the CRM at all.
 *
 * The MCP surface is authorized per tool and per credential — every tool
 * declares its own permission, an agent token is clamped to its own scopes, and
 * module entitlement is resolved per key. All of that answers "may this caller
 * run this tool". None of it answers the question a tenant actually has, which
 * is whether they want a machine touching their customer records at all.
 *
 * Those are different questions, and answering only the first meant every
 * organisation with CRM had a live agent surface whether or not anybody there
 * had decided to have one. A per-tool key cannot express "we do not do this" —
 * an admin holds `crm:deals:read` because they read deals, not because they
 * consented to an agent reading them.
 *
 * ## Off is the default, and existing integrations were not broken to get there
 *
 * A row's absence means off. That is the safe reading for a capability nobody
 * asked for, and it is why the column is not simply defaulted true. The
 * migration backfills `enabled = true` for every organisation that already had
 * an unrevoked, unexpired agent token — those tenants demonstrably opted in by
 * minting one, and turning them off would have been a silent outage dressed up
 * as a security improvement.
 */
export const crmMcpSettings = pgTable("crm_mcp_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  updatedByUserId: text("updated_by_user_id"),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export type CrmMcpSettings = typeof crmMcpSettings.$inferSelect;
