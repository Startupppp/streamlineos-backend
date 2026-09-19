import { relations } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";
import {
  projects,
  sprints,
  projectStatuses,
  cycles,
  modules,
  projectTemplates,
  projectTemplateTickets,
} from "./core";
import { sprintScopeEvents } from "./sprint-events";
import {
  tickets,
  ticketAssignees,
  ticketComments,
  ticketAttachments,
  ticketLabels,
  ticketLabelMappings,
  ticketWatchers,
  workItemRelations,
  ticketChecklists,
  ticketChecklistItems,
  projectReleases,
  releaseTickets,
  projectWebhooks,
  webhookDeliveries,
  ticketCommentReactions,
  projectAutomations,
} from "./tasks";
import {
  projectMembers,
  projectViews,
  intakeItems,
  pages,
  projectMilestones,
} from "./members";

export const projectsRelations = relations(projects, ({ one, many }) => ({
  tickets: many(tickets),
  manager: one(organizationMembers, {
    fields: [projects.managerMembershipId],
    references: [organizationMembers.id],
    relationName: "projectManager",
  }),
  client: one(organizationMembers, {
    fields: [projects.clientMembershipId],
    references: [organizationMembers.id],
    relationName: "projectClient",
  }),
  members: many(projectMembers),
  statuses: many(projectStatuses, { relationName: "projectStatuses" }),
  milestones: many(projectMilestones),
}));

export const sprintsRelations = relations(sprints, ({ one, many }) => ({
  project: one(projects, { fields: [sprints.projectId], references: [projects.id] }),
  tickets: many(tickets),
}));

export const cyclesRelations = relations(cycles, ({ one, many }) => ({
  project: one(projects, { fields: [cycles.projectId], references: [projects.id] }),
  organization: one(organizations, { fields: [cycles.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [cycles.createdBy], references: [users.id] }),
  tickets: many(tickets),
}));

export const modulesRelations = relations(modules, ({ one, many }) => ({
  project: one(projects, { fields: [modules.projectId], references: [projects.id] }),
  organization: one(organizations, { fields: [modules.orgId], references: [organizations.id] }),
  lead: one(users, { fields: [modules.leadId], references: [users.id], relationName: "moduleLead" }),
  creator: one(users, { fields: [modules.createdBy], references: [users.id], relationName: "moduleCreator" }),
  tickets: many(tickets),
}));

export const projectTemplatesRelations = relations(projectTemplates, ({ one, many }) => ({
  org: one(organizations, { fields: [projectTemplates.orgId], references: [organizations.id] }),
  createdBy: one(users, { fields: [projectTemplates.createdBy], references: [users.id] }),
  tickets: many(projectTemplateTickets),
}));

export const projectTemplateTicketsRelations = relations(projectTemplateTickets, ({ one }) => ({
  template: one(projectTemplates, { fields: [projectTemplateTickets.templateId], references: [projectTemplates.id] }),
}));

export const ticketsRelations = relations(tickets, ({ one, many }) => ({
  project: one(projects, { fields: [tickets.projectId], references: [projects.id] }),
  sprint: one(sprints, { fields: [tickets.sprintId], references: [sprints.id] }),
  assignee: one(organizationMembers, {
    fields: [tickets.assigneeMembershipId],
    references: [organizationMembers.id],
    relationName: "assignee",
  }),
  reporter: one(users, { fields: [tickets.reporterId], references: [users.id], relationName: "reporter" }),
  module: one(modules, { fields: [tickets.moduleId], references: [modules.id] }),
  cycle: one(cycles, { fields: [tickets.cycleId], references: [cycles.id] }),
  comments: many(ticketComments),
  attachments: many(ticketAttachments),
  labels: many(ticketLabelMappings),
  assignees: many(ticketAssignees),
  watchers: many(ticketWatchers),
  relations: many(workItemRelations),
}));

export const ticketAssigneesRelations = relations(ticketAssignees, ({ one }) => ({
  ticket: one(tickets, { fields: [ticketAssignees.ticketId], references: [tickets.id] }),
  user: one(organizationMembers, {
    fields: [ticketAssignees.membershipId],
    references: [organizationMembers.id],
  }),
  assigner: one(users, { fields: [ticketAssignees.assignedBy], references: [users.id], relationName: "assigner" }),
}));

export const ticketCommentsRelations = relations(ticketComments, ({ one, many }) => ({
  ticket: one(tickets, { fields: [ticketComments.ticketId], references: [tickets.id] }),
  user: one(users, { fields: [ticketComments.userId], references: [users.id] }),
  parent: one(ticketComments, { fields: [ticketComments.parentCommentId], references: [ticketComments.id], relationName: "parentComment" }),
  reactions: many(ticketCommentReactions),
}));

export const ticketAttachmentsRelations = relations(ticketAttachments, ({ one }) => ({
  ticket: one(tickets, { fields: [ticketAttachments.ticketId], references: [tickets.id] }),
  uploader: one(users, { fields: [ticketAttachments.uploadedBy], references: [users.id] }),
}));

export const ticketLabelMappingsRelations = relations(ticketLabelMappings, ({ one }) => ({
  ticket: one(tickets, { fields: [ticketLabelMappings.ticketId], references: [tickets.id] }),
  label: one(ticketLabels, { fields: [ticketLabelMappings.labelId], references: [ticketLabels.id] }),
}));

export const ticketLabelsRelations = relations(ticketLabels, ({ many }) => ({
  tickets: many(ticketLabelMappings),
}));

export const ticketWatchersRelations = relations(ticketWatchers, ({ one }) => ({
  ticket: one(tickets, { fields: [ticketWatchers.ticketId], references: [tickets.id] }),
  user: one(organizationMembers, {
    fields: [ticketWatchers.membershipId],
    references: [organizationMembers.id],
  }),
}));

export const workItemRelationsRelations = relations(workItemRelations, ({ one }) => ({
  workItem: one(tickets, { fields: [workItemRelations.workItemId], references: [tickets.id] }),
  relatedWorkItem: one(tickets, { fields: [workItemRelations.relatedWorkItemId], references: [tickets.id] }),
}));

export const projectStatusesRelations = relations(projectStatuses, ({ one }) => ({
  project: one(projects, { fields: [projectStatuses.projectId], references: [projects.id], relationName: "projectStatuses" }),
}));

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, { fields: [projectMembers.projectId], references: [projects.id] }),
  user: one(organizationMembers, {
    fields: [projectMembers.membershipId],
    references: [organizationMembers.id],
  }),
}));

export const projectViewsRelations = relations(projectViews, ({ one }) => ({
  project: one(projects, { fields: [projectViews.projectId], references: [projects.id] }),
  organization: one(organizations, { fields: [projectViews.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [projectViews.createdBy], references: [users.id] }),
}));

export const intakeItemsRelations = relations(intakeItems, ({ one }) => ({
  project: one(projects, { fields: [intakeItems.projectId], references: [projects.id] }),
  organization: one(organizations, { fields: [intakeItems.orgId], references: [organizations.id] }),
  linkedWorkItem: one(tickets, { fields: [intakeItems.linkedWorkItemId], references: [tickets.id] }),
}));

export const pagesRelations = relations(pages, ({ one, many }) => ({
  project: one(projects, { fields: [pages.projectId], references: [projects.id] }),
  organization: one(organizations, { fields: [pages.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [pages.createdBy], references: [users.id] }),
  parent: one(pages, { fields: [pages.parentPageId], references: [pages.id], relationName: "parentPage" }),
  children: many(pages, { relationName: "parentPage" }),
}));

export const projectMilestonesRelations = relations(projectMilestones, ({ one }) => ({
  project: one(projects, { fields: [projectMilestones.projectId], references: [projects.id] }),
  creator: one(users, { fields: [projectMilestones.createdBy], references: [users.id] }),
}));

export const ticketChecklistsRelations = relations(ticketChecklists, ({ many }) => ({
  items: many(ticketChecklistItems),
}));

export const ticketChecklistItemsRelations = relations(ticketChecklistItems, ({ one }) => ({
  checklist: one(ticketChecklists, {
    fields: [ticketChecklistItems.checklistId],
    references: [ticketChecklists.id],
  }),
}));

export const projectReleasesRelations = relations(projectReleases, ({ many }) => ({
  tickets: many(releaseTickets),
}));

export const releaseTicketsRelations = relations(releaseTickets, ({ one }) => ({
  release: one(projectReleases, {
    fields: [releaseTickets.releaseId],
    references: [projectReleases.id],
  }),
  ticket: one(tickets, {
    fields: [releaseTickets.ticketId],
    references: [tickets.id],
  }),
}));

export const projectWebhooksRelations = relations(projectWebhooks, ({ one, many }) => ({
  project: one(projects, { fields: [projectWebhooks.projectId], references: [projects.id] }),
  deliveries: many(webhookDeliveries),
}));

export const webhookDeliveriesRelations = relations(webhookDeliveries, ({ one }) => ({
  webhook: one(projectWebhooks, { fields: [webhookDeliveries.webhookId], references: [projectWebhooks.id] }),
}));

export const ticketCommentReactionsRelations = relations(ticketCommentReactions, ({ one }) => ({
  comment: one(ticketComments, { fields: [ticketCommentReactions.commentId], references: [ticketComments.id] }),
  membership: one(organizationMembers, {
    fields: [ticketCommentReactions.membershipId],
    references: [organizationMembers.id],
  }),
}));

export const projectAutomationsRelations = relations(projectAutomations, ({ one }) => ({
  project: one(projects, { fields: [projectAutomations.projectId], references: [projects.id] }),
}));

export const sprintScopeEventsRelations = relations(sprintScopeEvents, ({ one }) => ({
  org: one(organizations, { fields: [sprintScopeEvents.orgId], references: [organizations.id] }),
  sprint: one(sprints, { fields: [sprintScopeEvents.sprintId], references: [sprints.id] }),
  ticket: one(tickets, { fields: [sprintScopeEvents.ticketId], references: [tickets.id] }),
  actorMembership: one(organizationMembers, {
    fields: [sprintScopeEvents.orgId, sprintScopeEvents.actorMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
  }),
}));
