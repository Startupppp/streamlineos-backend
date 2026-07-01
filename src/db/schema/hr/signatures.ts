import { pgTable, text, serial, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { organizations, users } from "../auth";

export const signatureRequests = pgTable("signature_requests", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  documentType: text("document_type").notNull(),
  documentUrl: text("document_url").notNull(),
  requestedBy: text("requested_by").references(() => users.id, { onDelete: "cascade" }).notNull(),
  signers: jsonb("signers").$type<{ userId: string; order: number; signedAt?: string; signatureUrl?: string; status: string }[]>().default([]).notNull(),
  status: text("status").default("PENDING").notNull(),
  expiresAt: timestamp("expires_at"),
  completedAt: timestamp("completed_at"),
  auditTrail: jsonb("audit_trail").$type<{ action: string; userId: string; timestamp: string }[]>().default([]).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_signature_requests_org_status").on(table.orgId, table.status),
  index("idx_signature_requests_requested_by").on(table.requestedBy),
]);
