import { sql } from "drizzle-orm";
import { organizationMembers, projects, tickets, users } from "../../../../db/schema";

export const WORK_ROW_SELECTION = {
  id: tickets.id,
  title: tickets.title,
  status: tickets.status,
  priority: tickets.priority,
  type: tickets.type,
  dueDate: tickets.dueDate,
  startDate: tickets.startDate,
  ticketNumber: tickets.ticketNumber,
  points: tickets.points,
  estimate: tickets.estimate,
  rank: tickets.rank,
  createdAt: tickets.createdAt,
  updatedAt: tickets.updatedAt,
  assigneeId: sql<string | null>`${organizationMembers.userId}`,
  cycleId: tickets.cycleId,
  epicId: tickets.epicId,
  projectId: projects.id,
  projectKey: projects.key,
  projectName: projects.name,
  assigneeName: users.name,
  assigneeFirstName: users.firstName,
  assigneeLastName: users.lastName,
  assigneeEmail: users.email,
  assigneeImage: users.image,
} as const;
