import { pgTable, serial, text, integer, boolean, jsonb, timestamp, index, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
import { signWatermarkScopeEnum } from "./enums";

export const signWatermarkPolicies = pgTable(
  "sign_watermark_policies",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    scopeType: signWatermarkScopeEnum("scope_type").default("tenant").notNull(),
    scopeId: integer("scope_id"),
    // Envelope statuses this watermark applies to, e.g. ["draft","sent","completed","voided","expired"].
    appliesStates: jsonb("applies_states").$type<string[]>().default([]).notNull(),
    text: text("text"),
    imageFileKey: text("image_file_key"),
    opacity: integer("opacity").default(30).notNull(),
    angle: integer("angle").default(45).notNull(),
    color: text("color").default("#94A3B8").notNull(),
    fontSize: integer("font_size").default(36).notNull(),
    placement: text("placement").default("diagonal_tiled").notNull(),
    pages: jsonb("pages").$type<{ mode: "all" | "first" | "custom"; pageNumbers?: number[] }>()
      .default({ mode: "all" }).notNull(),
    showOnFinalPdf: boolean("show_on_final_pdf").default(true).notNull(),
    previewOnly: boolean("preview_only").default(false).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_sign_watermark_policies_org_scope").on(table.orgId, table.scopeType, table.scopeId),
    unique("uniq_sign_watermark_policies_org_id").on(table.orgId, table.id),
  ],
);

export const signWatermarkPoliciesRelations = relations(signWatermarkPolicies, ({ one }) => ({
  organization: one(organizations, { fields: [signWatermarkPolicies.orgId], references: [organizations.id] }),
}));
