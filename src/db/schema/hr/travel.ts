import { integer, pgTable, text, serial, timestamp, boolean, decimal, jsonb, index, unique } from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";

export const travelRequests = pgTable("travel_requests", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  purpose: text("purpose").notNull(),
  destination: text("destination").notNull(),
  departureDate: text("departure_date").notNull(),
  returnDate: text("return_date").notNull(),
  flightRequired: boolean("flight_required").default(false).notNull(),
  hotelRequired: boolean("hotel_required").default(false).notNull(),
  advanceRequired: boolean("advance_required").default(false).notNull(),
  advanceAmount: decimal("advance_amount", { precision: 15, scale: 2 }),
  estimatedCost: decimal("estimated_cost", { precision: 15, scale: 2 }),
  perDiem: decimal("per_diem", { precision: 15, scale: 2 }),
  itinerary: jsonb("itinerary").$type<{ date: string; activity: string; location: string }[]>().default([]).notNull(),
  status: text("status").default("DRAFT").notNull(),
  managerApproverId: text("manager_approver_id"),
  managerApproverMembershipId: integer("manager_approver_membership_id"),
  managerApprovedAt: timestamp("manager_approved_at"),
  financeApproverId: text("finance_approver_id"),
  financeApproverMembershipId: integer("finance_approver_membership_id"),
  financeApprovedAt: timestamp("finance_approved_at"),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_travel_requests_org_id").on(table.orgId, table.id),
  index("idx_travel_requests_org_status").on(table.orgId, table.status),
  index("idx_travel_requests_user").on(table.userId),
]);
