import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { successSchema } from "../../../common/openapi/response-envelopes";

export const leadPartySchema = z.object({
  id: z.number().int(),
  partyId: z.string(),
  orgId: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  whatsappNumber: z.string().nullable(),
  source: z.string(),
  subSource: z.string().nullable(),
  campaignId: z.number().int().nullable(),
  status: z.string(),
  priority: z.string(),
  investmentInterest: z.string().nullable(),
  potentialValue: z.string().nullable(),
  notes: z.string().nullable(),
  assignedToId: z.string().nullable(),
  assignedById: z.string().nullable(),
  verifiedById: z.string().nullable(),
  assignedAt: nullableWireDate(),
  convertedAt: nullableWireDate(),
  lostReason: z.string().nullable(),
  company: z.string().nullable(),
  designation: z.string().nullable(),
  city: z.string().nullable(),
  referredBy: z.string().nullable(),
  tags: z.array(z.string()),
  score: z.number().int().nullable(),
  slaDeadline: nullableWireDate(),
  website: z.string().nullable(),
  followUpDate: nullableWireDate(),
  followUpNotes: z.string().nullable(),
  customData: z.record(z.string(), z.unknown()).nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

const assigneeSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
});

export const leadDetailSchema = leadPartySchema.extend({
  assignedTo: assigneeSchema.extend({ email: z.string().nullable() }).nullable(),
  assignedBy: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  campaign: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  activities: z.array(
    z.object({
      id: z.number().int(),
      orgId: z.string(),
      leadId: z.number().int(),
      type: z.string(),
      date: wireDate(),
      duration: z.number().int().nullable(),
      subject: z.string().nullable(),
      location: z.string().nullable(),
      locationLink: z.string().nullable(),
      messageSummary: z.string().nullable(),
      notes: z.string().nullable(),
      outcome: z.string().nullable(),
      userId: z.string().nullable(),
      createdAt: wireDate(),
      user: z.object({ id: z.string(), name: z.string().nullable(), image: z.string().nullable() }).nullable(),
    }),
  ),
});

export const leadListSchema = z.object({
  leads: z.array(
    leadPartySchema.extend({
      assignedTo: assigneeSchema.nullable(),
      campaign: z.object({ id: z.number().int(), name: z.string() }).nullable(),
    }),
  ),
  totalCount: z.number().int().optional(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

const boardColumnSchema = z.object({
  leads: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      company: z.string().nullable(),
      source: z.string(),
      priority: z.string(),
      status: z.string(),
      score: z.number().int().nullable(),
      potentialValue: z.string().nullable(),
      slaDeadline: nullableWireDate(),
      createdAt: wireDate(),
      assignedTo: assigneeSchema.nullable(),
    }),
  ),
  total: z.number().int(),
});

export const leadBoardSchema = z.record(z.string(), boardColumnSchema);

export const leadStatsSchema = z.object({
  total: z.number().int(),
  byStatus: z.record(z.string(), z.number().int()),
  conversionRate: z.number(),
  totalPotentialValue: z.number(),
  unassigned: z.number().int(),
  thisMonth: z.number().int(),
});

export const leadActivitySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  leadId: z.number().int(),
  type: z.string(),
  date: wireDate(),
  duration: z.number().int().nullable(),
  subject: z.string().nullable(),
  location: z.string().nullable(),
  locationLink: z.string().nullable(),
  messageSummary: z.string().nullable(),
  notes: z.string().nullable(),
  outcome: z.string().nullable(),
  userId: z.string().nullable(),
  createdAt: wireDate(),
  user: z.object({ id: z.string(), name: z.string().nullable(), image: z.string().nullable() }).nullable().optional(),
});

const timelineItemSchema = z.object({
  id: z.number().int(),
  type: z.enum(["note", "task", "email", "activity"]),
  timestamp: wireDate().nullable(),
  data: z.record(z.string(), z.unknown()),
});

export const leadTimelineSchema = z.array(timelineItemSchema);

export const leadScoreExplanationSchema = z.object({
  score: z.number().int(),
  firedRules: z.array(
    z.object({
      name: z.string(),
      field: z.string(),
      operator: z.string(),
      value: z.string(),
      points: z.number().int(),
      dimension: z.string(),
    }),
  ),
  totalRules: z.number().int(),
  dimensionBreakdown: z.record(z.string(), z.number()),
});

export const leadCustomDataSchema = z.object({
  customData: z.record(z.string(), z.unknown()).nullable(),
});

export const leadMutatedSchema = leadPartySchema;

export const leadsAnalyticsSchema = z.object({
  totalLeads: z.number().int(),
  totalLeadsPrevPeriod: z.number().int(),
  conversionRate: z.number(),
  conversionRatePrevPeriod: z.number(),
  totalRevenue: z.number(),
  conversionBySource: z.array(
    z.object({
      source: z.string(),
      count: z.number().int(),
      converted: z.number().int(),
      conversionRate: z.number(),
      totalValue: z.number(),
    }),
  ),
  monthlyRevenue: z.array(z.object({ month: z.string(), revenue: z.number() })),
  assignmentDistribution: z.array(
    z.object({ userId: z.string(), name: z.string(), count: z.number().int() }),
  ),
});

export const leadsDashboardMetricsSchema = z.object({
  activeClients: z.number().int(),
  inactiveClients: z.number().int(),
  totalCalls: z.number().int(),
  inPersonMeetings: z.number().int(),
  followUpDue: z.number().int(),
  totalLeads: z.number().int(),
  conversionRate: z.number(),
});

export const leadsSourceReportSchema = z.object({
  sources: z.array(
    z.object({
      source: z.string(),
      count: z.number().int(),
      converted: z.number().int(),
      conversionRate: z.number(),
      totalValue: z.number(),
    }),
  ),
  total: z.number().int(),
});

export const leadsSalesLeaderboardSchema = z.array(
  z.object({
    userId: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
    totalCalls: z.number().int(),
    totalMeetings: z.number().int(),
    totalEmails: z.number().int(),
    leadsAssigned: z.number().int(),
    leadsConverted: z.number().int(),
    totalRevenue: z.number(),
    score: z.number(),
  }),
);

export const leadsSalesTeamCapacitySchema = z.array(
  z.object({
    id: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
    activeLeads: z.number().int(),
  }),
);

export const leadsSlaAlertsSchema = z.object({
  total: z.number().int(),
  leads: z.array(
    z.object({
      leadId: z.number().int(),
      leadName: z.string(),
      status: z.string(),
      assignedTo: z.string().nullable(),
      hoursSinceUpdate: z.number().int(),
      priority: z.string(),
    }),
  ),
});

export const leadsFollowUpsSchema = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      company: z.string().nullable(),
      status: z.string(),
      priority: z.string(),
      followUpDate: nullableWireDate(),
      followUpNotes: z.string().nullable(),
      assignedToId: z.string().nullable(),
      assigneeName: z.string().nullable(),
    }),
  ),
  total: z.number().int(),
});

export const leadsUnverifiedSchema = z.array(
  leadPartySchema.extend({
    assignedTo: assigneeSchema.nullable(),
  }),
);

export const leadsDuplicateGroupsSchema = z.object({
  groups: z.array(z.record(z.string(), z.unknown())),
  total: z.number().int(),
});

export const leadsCheckDuplicatesSchema = z.object({
  duplicates: z.array(z.record(z.string(), z.unknown())),
});

export const leadsBulkUpdateSchema = z.object({
  updated: z.number().int(),
});

export const leadsBulkDeleteSchema = z.object({
  deleted: z.number().int(),
  requested: z.number().int(),
});

export const leadsMergeSchema = z.object({
  merged: z.literal(true),
  winner: leadPartySchema,
});

export const leadsImportSchema = z.object({
  imported: z.number().int(),
  skipped: z.number().int(),
  updated: z.number().int(),
  errors: z.array(z.unknown()),
  duplicatesFound: z.number().int(),
  distributed: z.number().int(),
  salesPeopleCount: z.number().int(),
});

export const leadsDistributeSchema = z.object({
  distributed: z.number().int(),
  salesPeople: z.number().int(),
  totalSalesPeople: z.number().int(),
  absentCount: z.number().int(),
  absentNames: z.array(z.string()),
  summary: z.array(
    z.object({ userId: z.string(), name: z.string(), count: z.number().int() }),
  ),
});

export const leadsImportBatchSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  filename: z.string(),
  status: z.string(),
  totalRows: z.number().int(),
  importedRows: z.number().int(),
  failedRows: z.number().int(),
  errorReport: z.array(z.object({ row: z.number().int(), error: z.string() })).nullable(),
  createdAt: wireDate(),
  completedAt: nullableWireDate(),
});

export { successSchema };

