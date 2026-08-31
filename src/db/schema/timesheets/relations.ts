import { relations } from "drizzle-orm";
import { organizationMembers } from "../common/auth";
import { projects } from "../build/core";
import { tickets } from "../build/tasks";
import { timesheets } from "./entries";
import { timesheetPeriods } from "./periods";
import { timesheetExports } from "./exports";
import { timerSessions } from "./timer";
import { timesheetRateCards, timesheetRates } from "./rates";
import { timesheetBudgets } from "./budgets";

export const timesheetsRelations = relations(timesheets, ({ one }) => ({
  ticket: one(tickets, { fields: [timesheets.ticketId], references: [tickets.id] }),
  userMember: one(organizationMembers, {
    fields: [timesheets.orgId, timesheets.userMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
  }),
  project: one(projects, { fields: [timesheets.projectId], references: [projects.id] }),
  period: one(timesheetPeriods, { fields: [timesheets.timesheetPeriodId], references: [timesheetPeriods.id] }),
  timerSession: one(timerSessions, { fields: [timesheets.timerSessionId], references: [timerSessions.id] }),
  payrollExport: one(timesheetExports, { fields: [timesheets.payrollExportId], references: [timesheetExports.id] }),
}));

export const timesheetPeriodsRelations = relations(timesheetPeriods, ({ one, many }) => ({
  userMember: one(organizationMembers, {
    fields: [timesheetPeriods.orgId, timesheetPeriods.userMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
  }),
  entries: many(timesheets),
}));

export const timerSessionsRelations = relations(timerSessions, ({ one }) => ({
  userMember: one(organizationMembers, {
    fields: [timerSessions.orgId, timerSessions.userMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
  }),
  project: one(projects, { fields: [timerSessions.projectId], references: [projects.id] }),
  ticket: one(tickets, { fields: [timerSessions.ticketId], references: [tickets.id] }),
}));

export const timesheetRateCardsRelations = relations(timesheetRateCards, ({ many }) => ({
  rates: many(timesheetRates),
}));

export const timesheetRatesRelations = relations(timesheetRates, ({ one }) => ({
  rateCard: one(timesheetRateCards, { fields: [timesheetRates.rateCardId], references: [timesheetRateCards.id] }),
  project: one(projects, { fields: [timesheetRates.projectId], references: [projects.id] }),
  userMember: one(organizationMembers, {
    fields: [timesheetRates.orgId, timesheetRates.userMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
  }),
}));

export const timesheetBudgetsRelations = relations(timesheetBudgets, ({ one }) => ({
  project: one(projects, { fields: [timesheetBudgets.projectId], references: [projects.id] }),
}));
