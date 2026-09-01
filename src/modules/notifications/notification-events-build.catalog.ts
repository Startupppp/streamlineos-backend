import {
  BUILD_TICKET_RESOURCE,
  IN_APP,
  IN_APP_EMAIL,
  IN_APP_PUSH_EMAIL,
} from "./notification-event-channel-policy";
import { notificationEvent } from "./notification-event-factory";

export const BUILD_NOTIFICATION_EVENTS = [
  notificationEvent("build.ticket.assigned", "build", "PROJECTS", "Task assigned to you", {
    defaultPriority: "HIGH", defaultChannels: IN_APP_PUSH_EMAIL,
    visibilityResourceKind: BUILD_TICKET_RESOURCE, rateLimitWindowSeconds: 3600, rateLimitMax: 50,
  }),
  notificationEvent("build.ticket.due_soon", "build", "PROJECTS", "Task due soon", {
    defaultChannels: IN_APP_EMAIL, ttlSeconds: 86400, visibilityResourceKind: BUILD_TICKET_RESOURCE,
  }),
  notificationEvent("build.ticket.overdue", "build", "PROJECTS", "Task overdue", {
    defaultPriority: "HIGH", defaultType: "WARNING", defaultChannels: IN_APP_EMAIL,
    visibilityResourceKind: BUILD_TICKET_RESOURCE,
  }),
  notificationEvent("build.comment.mention", "build", "PROJECTS", "Mentioned in a comment", {
    defaultPriority: "HIGH", defaultChannels: IN_APP_PUSH_EMAIL, dedupeWindowSeconds: 0,
    visibilityResourceKind: BUILD_TICKET_RESOURCE, rateLimitWindowSeconds: 3600, rateLimitMax: 60,
  }),
  notificationEvent("build.ticket.status_changed", "build", "PROJECTS", "Task status changed", {
    defaultPriority: "LOW", defaultChannels: IN_APP, rateLimitWindowSeconds: 3600, rateLimitMax: 100,
    visibilityResourceKind: BUILD_TICKET_RESOURCE,
  }),
  notificationEvent("build.sprint.started", "build", "PROJECTS", "Sprint started", { defaultChannels: IN_APP }),
  notificationEvent("build.sprint.ending", "build", "PROJECTS", "Sprint ending soon", {
    defaultChannels: IN_APP_EMAIL, ttlSeconds: 86400,
  }),
  notificationEvent("build.sprint.completed", "build", "PROJECTS", "Sprint completed", {
    defaultType: "SUCCESS", defaultChannels: IN_APP,
  }),
  notificationEvent("build.release.published", "build", "PROJECTS", "Release published", {
    defaultPriority: "LOW", defaultType: "SUCCESS", defaultChannels: IN_APP,
  }),
  notificationEvent("build.blocker.created", "build", "PROJECTS", "Blocker reported", {
    defaultPriority: "HIGH", defaultType: "WARNING", defaultChannels: IN_APP_EMAIL,
    visibilityResourceKind: BUILD_TICKET_RESOURCE,
  }),
  notificationEvent("build.approval.requested", "build", "WORKFLOW", "Approval requested", {
    defaultPriority: "HIGH", defaultChannels: IN_APP_EMAIL,
  }),
  notificationEvent("build.project.member_added", "build", "PROJECTS", "Added to a project", {
    defaultChannels: IN_APP_EMAIL,
  }),
  notificationEvent("build.ticket.review_requested", "build", "PROJECTS", "Ticket ready for review", {
    defaultPriority: "HIGH", defaultChannels: IN_APP_EMAIL, visibilityResourceKind: BUILD_TICKET_RESOURCE,
  }),
  notificationEvent("build.ticket.changes_requested", "build", "PROJECTS", "Changes requested", {
    defaultPriority: "HIGH", defaultType: "WARNING", defaultChannels: IN_APP_EMAIL,
    visibilityResourceKind: BUILD_TICKET_RESOURCE,
  }),
] as const;
