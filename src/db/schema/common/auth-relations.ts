import { relations } from "drizzle-orm";
import { organizations, users } from "./auth";
import { departments } from "../hr/employees";
import { tickets } from "../build/tasks";

export const organizationsHrRelations = relations(organizations, ({ many }) => ({
  departments: many(departments),
}));

export const usersHrBuildRelations = relations(users, ({ one, many }) => ({
  department: one(departments, {
    fields: [users.departmentId],
    references: [departments.id],
  }),
  assignedTickets: many(tickets, { relationName: "assignee" }),
  reportedTickets: many(tickets, { relationName: "reporter" }),
}));
