import { relations } from "drizzle-orm";
import { users } from "./common/auth";
import { tickets } from "./build/tasks";

export const usersHrBuildRelations = relations(users, ({ many }) => ({
  assignedTickets: many(tickets, { relationName: "assignee" }),
  reportedTickets: many(tickets, { relationName: "reporter" }),
}));
