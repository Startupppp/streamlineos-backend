import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../common/openapi/response-envelopes";

export const agentMeSchema = z.object({
  userId: z.string(),
  orgId: z.string(),
});

export const agentTokenCreateSchema = z.object({
  token: z.string(),
  id: z.number().int(),
  name: z.string(),
  tokenPrefix: z.string(),
  scopes: z.array(z.string()),
  expiresAt: nullableWireDate(),
  createdAt: wireDate(),
});

const agentTokenListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  tokenPrefix: z.string(),
  scopes: z.array(z.string()),
  lastUsedAt: nullableWireDate(),
  expiresAt: nullableWireDate(),
  revokedAt: nullableWireDate(),
  createdAt: wireDate(),
});

export const agentTokenListSchema = z.array(agentTokenListItemSchema);

const projectRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  key: z.string(),
  clientMembershipId: z.number().int().nullable(),
  managerMembershipId: z.number().int().nullable(),
  startDate: nullableWireDate(),
  endDate: nullableWireDate(),
  status: z.string(),
  priority: z.string().nullable(),
  dealId: z.number().int().nullable(),
  managedProductId: z.number().int().nullable(),
  pmWorkspaceId: z.string().nullable(),
  budget: z.string().nullable(),
  budgetMinor: z.number().nullable(),
  budgetCurrency: z.string().nullable(),
  settings: z.record(z.string(), z.unknown()).nullable(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export { projectRowSchema };

const ticketRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  type: z.string(),
  status: z.string(),
  priority: z.string(),
  projectId: z.number().int().nullable(),
  ticketNumber: z.number().int(),
  epicId: z.number().int().nullable(),
  assigneeMembershipId: z.number().int().nullable(),
  reporterId: z.string().nullable(),
  reporterMembershipId: z.number().int().nullable(),
  points: z.number().int().nullable(),
  storyPoints: z.number().int().nullable(),
  link: z.string().nullable(),
  rank: z.string(),
  parentTicketId: z.number().int().nullable(),
  originalEstimate: z.string().nullable(),
  timeSpent: z.string(),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  moduleId: z.number().int().nullable(),
  cycleId: z.number().int().nullable(),
  sequenceId: z.string().nullable(),
  estimate: z.number().int().nullable(),
  completionPercentage: z.number().int(),
  clientVisible: z.boolean(),
  isRecurring: z.boolean(),
  recurrenceRule: z.record(z.string(), z.unknown()).nullable(),
  recurrenceParentId: z.number().int().nullable(),
  recurrenceNextRunAt: nullableWireDate(),
  customerId: z.number().int().nullable(),
  version: z.number().int(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export { ticketRowSchema };

const userStubSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
});

const labelStubSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  color: z.string(),
});

const ticketListItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  type: z.string(),
  status: z.string(),
  priority: z.string(),
  projectId: z.number().int().nullable(),
  ticketNumber: z.number().int(),
  epicId: z.number().int().nullable(),
  assigneeId: z.string().nullable(),
  reporterId: z.string().nullable(),
  points: z.number().int().nullable(),
  storyPoints: z.number().int().nullable(),
  link: z.string().nullable(),
  rank: z.string(),
  parentTicketId: z.number().int().nullable(),
  originalEstimate: z.string().nullable(),
  timeSpent: z.string(),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  moduleId: z.number().int().nullable(),
  cycleId: z.number().int().nullable(),
  sequenceId: z.string().nullable(),
  estimate: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  assignee: userStubSchema.nullable(),
  assignees: z.array(z.object({ user: userStubSchema })),
  labels: z.array(z.object({ label: labelStubSchema })),
  cycle: z
    .object({
      id: z.number().int(),
      name: z.string(),
      status: z.string(),
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
    })
    .nullable(),
});

const ticketListPaginationSchema = z.object({
  limit: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const ticketListPageSchema = z.object({
  data: z.array(ticketListItemSchema),
  pagination: ticketListPaginationSchema,
});

const workItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  type: z.string(),
  dueDate: z.string().nullable(),
  startDate: z.string().nullable(),
  ticketNumber: z.number().int(),
  points: z.number().int().nullable(),
  estimate: z.number().int().nullable(),
  rank: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  assigneeId: z.string().nullable(),
  cycleId: z.number().int().nullable(),
  epicId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  projectKey: z.string(),
  projectName: z.string(),
  assignee: userStubSchema.nullable(),
  labels: z.array(labelStubSchema),
});

export const allWorkSchema = z.object({
  data: z.array(workItemSchema),
  limit: z.number().int(),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  total: z.number().int().optional(),
});

export const updateTicketSchema = z.object({
  updated: z.literal(true),
  updatedAt: z.string(),
});

export const ticketCommentRowSchema = z.object({
  id: z.number(),
  orgId: z.string(),
  ticketId: z.number().int(),
  userId: z.string(),
  content: z.string(),
  clientVisible: z.boolean(),
  parentCommentId: z.number().nullable(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const ticketAttachmentSchema = z.object({
  id: z.number().int(),
  fileName: z.string(),
  fileUrl: z.string(),
  mimeType: z.string().nullable(),
  fileSize: z.number().int().nullable(),
});

const ticketInlineImageSchema = z.object({
  url: z.string(),
  source: z.enum(["description", "comment"]),
});

const ticketCommentSchema = z.object({
  id: z.number(),
  body: z.string(),
  authorId: z.string().nullable(),
  authorName: z.string().nullable(),
  createdAt: wireDate(),
});

const ticketProjectSchema = z
  .object({ id: z.number().int(), key: z.string(), name: z.string() })
  .nullable();

export const agentTicketDetailSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  type: z.string(),
  description: z.string().nullable(),
  ticketNumber: z.number().int(),
  projectId: z.number().int().nullable(),
  assigneeMembershipId: z.number().int().nullable(),
  dueDate: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  project: ticketProjectSchema,
  comments: z.array(ticketCommentSchema),
  attachments: z.array(ticketAttachmentSchema),
  inlineImages: z.array(ticketInlineImageSchema),
});
