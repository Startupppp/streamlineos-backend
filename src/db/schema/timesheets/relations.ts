import { relations } from "drizzle-orm";
import { users } from "../auth";
import { projects } from "../build/core";
import { tickets } from "../build/tasks";
import { timesheets } from "./entries";
import { timesheetPeriods } from "./periods";
import { timerSessions } from "./timer";
import { timesheetRateCards, timesheetRates } from "./rates";
import { timesheetBudgets } from "./budgets";
import { timesheetExports } from "./exports";

export const timesheetsRelations = relations(timesheets, ({ one }) => ({
  ticket: one(tickets, { fields: [timesheets.ticketId], references: [tickets.id] }),
  user: one(users, { fields: [timesheets.userId], references: [users.id] }),
  project: one(projects, { fields: [timesheets.projectId], references: [projects.id] }),
  period: one(timesheetPeriods, { fields: [timesheets.timesheetPeriodId], references: [timesheetPeriods.id] }),
  timerSession: one(timerSessions, { fields: [timesheets.timerSessionId], references: [timerSessions.id] }),
  payrollExport: one(timesheetExports, { fields: [timesheets.payrollExportId], references: [timesheetExports.id] }),
}));

export const timesheetPeriodsRelations = relations(timesheetPeriods, ({ one, many }) => ({
  user: one(users, { fields: [timesheetPeriods.userId], references: [users.id] }),
  entries: many(timesheets),
}));

export const timerSessionsRelations = relations(timerSessions, ({ one }) => ({
  user: one(users, { fields: [timerSessions.userId], references: [users.id] }),
  project: one(projects, { fields: [timerSessions.projectId], references: [projects.id] }),
  ticket: one(tickets, { fields: [timerSessions.ticketId], references: [tickets.id] }),
}));

export const timesheetRateCardsRelations = relations(timesheetRateCards, ({ many }) => ({
  rates: many(timesheetRates),
}));

export const timesheetRatesRelations = relations(timesheetRates, ({ one }) => ({
  rateCard: one(timesheetRateCards, { fields: [timesheetRates.rateCardId], references: [timesheetRateCards.id] }),
  project: one(projects, { fields: [timesheetRates.projectId], references: [projects.id] }),
  user: one(users, { fields: [timesheetRates.userId], references: [users.id] }),
}));

export const timesheetBudgetsRelations = relations(timesheetBudgets, ({ one }) => ({
  project: one(projects, { fields: [timesheetBudgets.projectId], references: [projects.id] }),
}));

export const timesheetExportsRelations = relations(timesheetExports, ({ one }) => ({
  createdByUser: one(users, { fields: [timesheetExports.createdBy], references: [users.id] }),
}));
