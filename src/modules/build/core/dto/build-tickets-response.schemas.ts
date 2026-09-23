import { z } from "zod";
import {
  wireDate,
  nullableWireDate,
} from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

const userSummarySchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string(),
    image: z.string().nullable(),
  })
  .nullable();

export const ticketRowSchema = z.object({
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
  recurrenceRule: z.unknown(),
  recurrenceParentId: z.number().int().nullable(),
  recurrenceNextRunAt: nullableWireDate(),
  customerId: z.number().int().nullable(),
  version: z.number().int(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const ticketDetailSchema = ticketRowSchema.extend({
  project: z
    .object({
      id: z.number().int(),
      name: z.string(),
      key: z.string(),
      orgId: z.string(),
    })
    .nullable(),
  epic: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  assignee: z.object({ user: userSummarySchema }).nullable(),
  reporter: userSummarySchema,
  assignees: z.array(
    z.object({
      id: z.number().int(),
      ticketId: z.number().int(),
      assignedAt: wireDate(),
      assignedBy: z.string().nullable(),
      user: z.object({
        userId: z.string(),
        user: userSummarySchema,
      }),
    }),
  ),
  members: z.array(z.object({ user: z.object({ user: userSummarySchema }) })),
  watchers: z.array(z.object({ user: userSummarySchema })),
  attachments: z.array(
    z.object({
      id: z.number().int(),
      filename: z.string(),
      url: z.string(),
      uploader: userSummarySchema,
    }),
  ),
  labels: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      color: z.string().nullable(),
    }),
  ),
  comments: z
    .array(
      z.object({
        id: z.number().int(),
        orgId: z.string(),
        ticketId: z.number().int(),
        userId: z.string(),
        content: z.string(),
        parentCommentId: z.number().int().nullable(),
        createdAt: wireDate(),
        updatedAt: wireDate(),
        user: userSummarySchema,
        reactions: z.array(z.object({ emoji: z.string(), userId: z.string() })).default([]),
      }),
    )
    .default([]),
});

export const ticketListRowSchema = ticketRowSchema
  .pick({
    id: true,
    orgId: true,
    title: true,
    type: true,
    status: true,
    priority: true,
    projectId: true,
    ticketNumber: true,
    epicId: true,
    assigneeMembershipId: true,
    reporterId: true,
    points: true,
    storyPoints: true,
    link: true,
    rank: true,
    parentTicketId: true,
    originalEstimate: true,
    timeSpent: true,
    startDate: true,
    dueDate: true,
    moduleId: true,
    cycleId: true,
    sequenceId: true,
    estimate: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    descriptionExcerpt: z.string(),
    assigneeId: z.string().nullable(),
    assignee: userSummarySchema,
    assignees: z.array(
      z.object({
        id: z.number().int(),
        ticketId: z.number().int(),
        assignedAt: wireDate(),
        assignedBy: z.string().nullable(),
        userId: z.string(),
        user: userSummarySchema.unwrap(),
      }),
    ),
    labels: z.array(
      z.object({
        id: z.number().int(),
        ticketId: z.number().int(),
        labelId: z.number().int(),
        createdAt: wireDate(),
        label: z.object({
          id: z.number().int(),
          orgId: z.string(),
          name: z.string(),
          color: z.string().nullable(),
          createdAt: wireDate(),
        }),
      }),
    ),
    cycle: z
      .object({
        id: z.number().int(),
        name: z.string(),
        status: z.string(),
        startDate: z.string(),
        endDate: z.string(),
      })
      .nullable(),
  });

export const ticketListPageSchema = z.object({
  data: z.array(ticketListRowSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const ticketSearchResultSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  ticketNumber: z.number().int(),
  projectId: z.number().int(),
  projectKey: z.string(),
  projectName: z.string(),
});

export const ticketSearchResultListSchema = z.array(ticketSearchResultSchema);

const activityItemSchema = z.object({
  id: z.number().int(),
  action: z.string(),
  label: z.string(),
  fromValue: z.string().nullable(),
  toValue: z.string().nullable(),
  createdAt: wireDate(),
  user: z
    .object({
      id: z.string().nullable(),
      name: z.string().nullable(),
      image: z.string().nullable(),
    })
    .nullable(),
});

export const ticketActivityPageSchema = cursorPageSchema(activityItemSchema);

export const watcherMutationSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  membershipId: z.number().int(),
});

export const ticketWatcherSchema = z.object({
  id: z.number().int(),
  ticketId: z.number().int(),
  createdAt: wireDate(),
  userId: z.string().nullable(),
  user: userSummarySchema,
});

export const ticketRelationSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  workItemId: z.number().int(),
  relatedWorkItemId: z.number().int(),
  relationType: z.enum(["blocks", "blocked_by", "duplicate_of", "relates_to"]),
  createdAt: wireDate(),
});

export const ticketRelationListItemSchema = z.object({
  id: z.number().int(),
  relationType: z.enum(["blocks", "blocked_by", "duplicate_of", "relates_to"]),
  direction: z.enum(["outgoing", "incoming"]),
  relatedTicket: z.object({
    id: z.number().int(),
    title: z.string(),
    ticketNumber: z.number().int(),
    status: z.string(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
    type: z.enum(["EPIC", "STORY", "TASK", "BUG"]),
    points: z.number().int().nullable(),
    assigneeMembershipId: z.number().int().nullable(),
    projectId: z.number().int().nullable(),
    project: z.object({ key: z.string() }).nullable(),
    assignee: userSummarySchema,
  }),
});

export const gitLinkSchema = z.object({
  id: z.number().int(),
  provider: z.enum(["github", "gitlab", "bitbucket"]),
  refType: z.enum(["commit", "pull_request", "branch"]),
  externalId: z.string(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  author: z.string().nullable(),
  status: z.string().nullable(),
  createdAt: wireDate(),
});

export const relatedLinkSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  ticketId: z.number().int(),
  url: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const checklistItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  checklistId: z.number().int(),
  text: z.string(),
  isCompleted: z.boolean(),
  assigneeId: z.string().nullable(),
  dueDate: z.string().nullable(),
  order: z.number().int(),
  createdAt: wireDate(),
});

export const checklistRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  ticketId: z.number().int(),
  title: z.string(),
  position: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  items: z.array(checklistItemSchema).optional(),
});

export { checklistItemSchema };

const commentAuthorSchema = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  email: z.string().nullable(),
});

export const commentRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  ticketId: z.number().int(),
  body: z.string(),
  clientVisible: z.boolean(),
  isEdited: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  author: commentAuthorSchema.nullable(),
});

export const commentEditResultSchema = z.object({ updated: z.literal(true) });

export const reactionSchema = z.object({
  commentId: z.number().int(),
  userId: z.string(),
  emoji: z.string(),
});

export const attachmentCreateResultSchema = z.object({ id: z.number().int() });

export const bulkUpdateResultSchema = z.object({
  updated: z.number().int(),
  ticketIds: z.array(z.number().int()),
});

export const rankTicketResultSchema = z.object({
  id: z.number().int(),
  rank: z.string(),
  status: z.string(),
});

export const ticketUpdateResultSchema = z.object({
  updated: z.literal(true),
  updatedAt: z.string(),
});

export const exportTicketsResultSchema = z.object({
  rows: z.array(ticketRowSchema),
  truncated: z.boolean(),
});

export const importTicketsResultSchema = z.object({
  created: z.number().int(),
  skipped: z.array(z.object({ row: z.number().int(), reason: z.string() })),
});

export const columnCountsSchema = z.record(z.string(), z.number().int());

export const allWorkItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  type: z.string(),
  status: z.string(),
  priority: z.string().nullable(),
  projectId: z.number().int().nullable(),
  projectKey: z.string().nullable(),
  projectName: z.string().nullable(),
  ticketNumber: z.number().int(),
  dueDate: z.string().nullable(),
  startDate: z.string().nullable(),
  points: z.number().nullable(),
  estimate: z.number().nullable(),
  rank: z.string().nullable(),
  cycleId: z.number().int().nullable(),
  epicId: z.number().int().nullable(),
  assigneeId: z.string().nullable(),
  assignee: userSummarySchema
    .unwrap()
    .extend({ email: z.string().nullable() })
    .nullable(),
  labels: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      color: z.string().nullable(),
    }),
  ),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const allWorkPageSchema = z.object({
  data: z.array(allWorkItemSchema),
  limit: z.number().int(),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  total: z.number().int().optional(),
});

const myIssueItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  status: z.string().nullable(),
  type: z.string().nullable(),
  priority: z.string().nullable(),
  ticketNumber: z.string(),
  updatedAt: wireDate(),
  projectName: z.string(),
  projectId: z.number().int().optional(),
  projectKey: z.string(),
  assignee: z
    .object({
      id: z.number().int(),
      firstName: z.string().nullable(),
      lastName: z.string().nullable(),
      image: z.string().nullable(),
    })
    .nullable(),
});

export const myIssuesSchema = z.array(myIssueItemSchema);
