import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

// ─── Automation rules ────────────────────────────────────────────────────────

export const automationRuleSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  trigger: z.string(),
  conditions: z.unknown(),
  actions: z.unknown(),
  isActive: z.boolean(),
  executionCount: z.number().int(),
  lastRunAt: nullableWireDate(),
  graph: z.unknown().nullable(),
  version: z.number().int(),
  isDraft: z.boolean(),
  lastError: z.string().nullable(),
  cooldownMinutes: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const automationRulesListSchema = z.object({
  rules: z.array(automationRuleSchema),
});

export const automationRuleSingleSchema = z.object({
  rule: automationRuleSchema,
});

export const automationEventSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  entityType: z.string(),
  isActive: z.boolean(),
  isSystemDefault: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const automationEventsListSchema = z.object({
  events: z.array(automationEventSchema),
});

export const automationActionSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  configSchema: z.unknown().nullable(),
  isActive: z.boolean(),
  isSystemDefault: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const automationActionsListSchema = z.object({
  actions: z.array(automationActionSchema),
});

export const automationRunSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  ruleId: z.number().int(),
  eventKey: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  status: z.string(),
  steps: z.unknown().nullable(),
  error: z.string().nullable(),
  triggeredBy: z.string(),
  startedAt: wireDate(),
  finishedAt: nullableWireDate(),
});

export const automationRunsPageSchema = z.object({
  runs: z.array(automationRunSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const automationDryRunSchema = z.object({
  matched: z.boolean(),
  nodes: z.array(
    z.object({
      nodeId: z.string(),
      type: z.string(),
      result: z.string(),
    }),
  ),
});

// ─── Organizations ────────────────────────────────────────────────────────────

export const crmOrgSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  size: z.string().nullable(),
  website: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: wireDate(),
});

export const crmOrgWithOpenRequestsSchema = crmOrgSchema.extend({
  openRequestCount: z.number().int(),
});

export const crmOrgsListSchema = z.object({
  organizations: z.array(crmOrgWithOpenRequestsSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  totalCount: z.number().int().optional(),
});

const potentialDuplicateSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  domain: z.string().nullable(),
  matchReason: z.enum(["domain", "name"]),
});

export const crmOrgCreatedSchema = crmOrgSchema.extend({
  possibleDuplicates: z.array(potentialDuplicateSchema),
});

const crmContactMirrorSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  organizationId: z.number().int().nullable(),
  leadId: z.number().int().nullable(),
  mergedIntoId: z.null(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  designation: z.string().nullable(),
  city: z.string().nullable(),
  website: z.string().nullable(),
});

export const crmOrgWithContactsSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  parentId: z.number().int().nullable(),
  mergedIntoId: z.null(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  name: z.string(),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  size: z.string().nullable(),
  website: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  description: z.string().nullable(),
  contacts: z.array(crmContactMirrorSchema),
});

export const crmOrgDuplicatePairSchema = z.object({
  items: z.array(
    z.object({
      org1: z.object({ id: z.number().int(), name: z.string(), domain: z.string().nullable() }),
      org2: z.object({ id: z.number().int(), name: z.string(), domain: z.string().nullable() }),
      matchReason: z.enum(["domain", "name"]),
    }),
  ),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const crmOrgPotentialDuplicatesSchema = z.array(potentialDuplicateSchema);

// ─── Territories ──────────────────────────────────────────────────────────────

export const territoryRepSchema = z.object({
  id: z.number().int(),
  crmPersonId: z.number().int(),
  assignedAt: wireDate(),
});

export const territoryLocationSchema = z.object({
  id: z.number().int(),
  kind: z.string(),
  value: z.string(),
});

export const territorySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  criteria: z.unknown(),
  priority: z.number().int(),
  createdBy: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
  reps: z.array(territoryRepSchema),
  locations: z.array(territoryLocationSchema),
});

export const territoryPreviewSchema = z.object({
  matchedTerritory: z.unknown().nullable(),
  assignedReps: z.array(z.number().int()),
  assignedRepNames: z.array(z.string()),
});

// ─── SLA ──────────────────────────────────────────────────────────────────────

export const slaPolicySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  appliesTo: z.string(),
  priority: z.string(),
  firstResponseHours: z.number().int(),
  resolutionHours: z.number().int(),
  conditions: z.unknown(),
  targetMinutes: z.number().int().nullable(),
  businessHours: z.boolean(),
  appliesToText: z.string().nullable(),
  priorityText: z.string().nullable(),
  createdAt: wireDate(),
});

export const slaBreachedLeadSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string().nullable(),
  status: z.string(),
  priority: z.string(),
  slaDeadline: nullableWireDate(),
  createdAt: wireDate(),
});

export const slaBreachedListSchema = z.array(slaBreachedLeadSchema);

export const slaReportSchema = z.object({
  total: z.number().int(),
  compliant: z.number().int(),
  breached: z.number().int(),
  complianceRate: z.number().int(),
});

// ─── Campaigns ────────────────────────────────────────────────────────────────

export const campaignSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  status: z.string(),
  channel: z.string().nullable(),
  description: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  targetAudience: z.string().nullable(),
  leads: z.number().int(),
  spend: z.string(),
  roi: z.string(),
  budgetAllocated: z.string().nullable(),
  budgetSpent: z.string().nullable(),
  utmCampaignKey: z.string().nullable(),
  ownerId: z.string().nullable(),
  ownerMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const campaignsListSchema = z.object({
  items: z.array(campaignSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const campaignRoiSchema = z.object({
  spend: z.number(),
  leads: z.number().int(),
  converted: z.number().int(),
  deals: z.number().int(),
  revenueCents: z.number().int(),
  roi: z.number(),
});

const campaignLeadSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  source: z.string(),
  campaignId: z.number().int().nullable(),
  status: z.string(),
  priority: z.string(),
  potentialValue: z.string().nullable(),
  assignedToId: z.string().nullable(),
  company: z.string().nullable(),
  score: z.number().int().nullable(),
  followUpDate: nullableWireDate(),
  convertedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const campaignLeadsSchema = z.object({
  items: z.array(campaignLeadSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

// ─── Rules ────────────────────────────────────────────────────────────────────

export const assignmentRuleSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  conditions: z.unknown(),
  assignmentType: z.string(),
  assignToUserId: z.string().nullable(),
  assignToMembershipId: z.number().int().nullable(),
  roundRobinUserIds: z.unknown(),
  priority: z.number().int(),
  isActive: z.boolean(),
  config: z.unknown(),
  assignmentTypeText: z.string().nullable(),
  createdAt: wireDate(),
});

export const scoringRuleSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  field: z.string(),
  operator: z.string(),
  value: z.string(),
  points: z.number().int(),
  dimension: z.string(),
  createdAt: wireDate(),
});

export const emailTemplateSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  subject: z.string(),
  body: z.string(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const assignmentPreviewSchema = z.object({
  matchedRule: z
    .object({ id: z.number().int(), name: z.string() })
    .nullable(),
  wouldAssignTo: z.string().nullable(),
  trace: z.array(
    z.object({
      ruleId: z.number().int(),
      ruleName: z.string(),
      matched: z.boolean(),
      reason: z.string(),
    }),
  ),
});

// ─── Web Forms ────────────────────────────────────────────────────────────────

const webFormFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.string(),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
});

export const webFormSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  fields: z.array(webFormFieldSchema),
  publicToken: z.string(),
  isActive: z.boolean(),
  submitMessage: z.string(),
  redirectUrl: z.string().nullable(),
  totalSubmissions: z.number().int(),
  createdBy: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

// ─── Products ─────────────────────────────────────────────────────────────────

export const crmProductSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sku: z.string().nullable(),
  category: z.string().nullable(),
  unitPrice: z.number().int(),
  currency: z.string(),
  taxRate: z.number().int(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const crmProductsListSchema = z.object({
  products: z.array(crmProductSchema),
  total: z.number().int(),
});

// ─── People ───────────────────────────────────────────────────────────────────

const trendSchema = z.object({
  value: z.number(),
  isPositive: z.boolean(),
});

const personStatSchema = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number()]),
  trend: trendSchema.optional(),
});

export const crmPersonDetailSchema = z.object({
  slug: z.string(),
  name: z.string(),
  initials: z.string(),
  role: z.string(),
  title: z.string().nullable(),
  department: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string(),
  location: z.string(),
  joinDate: z.string(),
  bio: z.string(),
  stats: z.array(personStatSchema),
  monthlyPerformance: z.array(z.object({ month: z.string(), value: z.number() })),
  deals: z.array(
    z.object({
      company: z.string().nullable(),
      value: z.number(),
      stage: z.string(),
      probability: z.number(),
      closeDate: z.string(),
    }),
  ),
  accounts: z.array(
    z.object({
      name: z.string(),
      revenue: z.number(),
      health: z.enum(["healthy", "at_risk", "critical"]),
      since: z.string(),
      renewalDate: z.string(),
    }),
  ),
  activities: z.array(
    z.object({
      type: z.string(),
      message: z.string(),
      time: z.string(),
    }),
  ),
  skills: z.array(z.string()),
});

export const crmPeopleSlugsSchema = z.record(z.string(), z.string());

// ─── Dashboards ───────────────────────────────────────────────────────────────

const statWithTrendSchema = z.object({
  value: z.union([z.number(), z.string()]),
  trend: trendSchema,
});

export const salesDashboardSchema = z.object({
  salesStats: z.object({
    pipeline: statWithTrendSchema,
    dealsWon: statWithTrendSchema,
    conversionRate: statWithTrendSchema,
    avgDealSize: statWithTrendSchema,
  }),
  revenueTimeline: z.array(z.object({ month: z.string(), value: z.number() })),
  salesFunnel: z.array(
    z.object({ stage: z.string(), value: z.number(), color: z.string() }),
  ),
  topDeals: z.array(
    z.object({
      company: z.string(),
      value: z.number(),
      stage: z.string(),
      rep: z.string(),
      probability: z.number(),
    }),
  ),
  salesLeaderboard: z.array(
    z.object({
      name: z.string(),
      deals: z.number().int(),
      revenue: z.number(),
      avatar: z.string(),
    }),
  ),
  salesActivity: z.array(
    z.object({
      type: z.string(),
      message: z.string(),
      time: z.string(),
      person: z.string(),
    }),
  ),
  dealsByStage: z.array(
    z.object({
      stage: z.string(),
      count: z.number().int(),
      value: z.number(),
      color: z.string(),
    }),
  ),
  enhancedMetrics: z.object({
    activeClients: z.number().int(),
    inactiveClients: z.number().int(),
    totalCalls: z.number().int(),
    totalMeetings: z.number().int(),
    totalEmails: z.number().int(),
    totalSiteVisits: z.number().int(),
    followUpNeeded: z.number().int(),
  }),
});

export const supportDashboardSchema = z.object({
  supportDashboardStats: z.object({
    openTickets: statWithTrendSchema,
    avgResolution: statWithTrendSchema,
    csatScore: statWithTrendSchema,
    responseRate: statWithTrendSchema,
  }),
  ticketStatusBreakdown: z.array(
    z.object({ label: z.string(), value: z.number().int(), color: z.string() }),
  ),
  ticketVolumeTimeline: z.array(
    z.object({ month: z.string(), value: z.number() }),
  ),
  supportActivityFeed: z.array(
    z.object({ type: z.string(), message: z.string(), time: z.string(), person: z.string() }),
  ),
  supportTeamMembers: z.array(
    z.object({
      name: z.string(),
      role: z.string(),
      access: z.string(),
      avatar: z.string(),
      status: z.literal("online"),
    }),
  ),
  ticketsByPriority: z.array(
    z.object({ label: z.string(), value: z.number().int(), color: z.string() }),
  ),
});

export const ceDashboardSchema = z.object({
  customerStats: z.object({
    totalClients: statWithTrendSchema,
    nps: statWithTrendSchema,
    csat: statWithTrendSchema,
    retention: statWithTrendSchema,
  }),
  clientHealth: z.array(
    z.object({ label: z.string(), value: z.number().int(), color: z.string() }),
  ),
  upcomingRenewals: z.array(
    z.object({
      client: z.string(),
      value: z.number(),
      date: z.string(),
      health: z.enum(["healthy", "at_risk", "critical"]),
    }),
  ),
  keyAccounts: z.array(
    z.object({
      name: z.string(),
      revenue: z.number(),
      health: z.string(),
      csm: z.string(),
      since: z.string(),
    }),
  ),
  customerInteractions: z.array(
    z.object({ type: z.string(), message: z.string(), time: z.string(), person: z.string() }),
  ),
  supportStats: z.object({
    openTickets: z.number().int(),
    avgResolution: z.number(),
    firstResponse: z.number(),
    satisfaction: z.number(),
  }),
  retentionTimeline: z.array(z.object({ month: z.string(), value: z.number() })),
  csatTimeline: z.array(z.object({ month: z.string(), value: z.number() })),
});

// ─── Customer360 ──────────────────────────────────────────────────────────────

const customer360SectionSchema = z.object({
  items: z.array(z.unknown()),
  total: z.number().int(),
});

export const customer360Schema = z.object({
  contacts: customer360SectionSchema.optional(),
  leads: customer360SectionSchema.optional(),
  deals: customer360SectionSchema.optional(),
  quotes: customer360SectionSchema.optional(),
  invoices: customer360SectionSchema.optional(),
  payments: customer360SectionSchema.optional(),
  supportTickets: customer360SectionSchema.optional(),
  surveys: customer360SectionSchema.optional(),
  activities: customer360SectionSchema.optional(),
  projects: customer360SectionSchema.optional(),
  signedDocuments: customer360SectionSchema.optional(),
});

export const customer360TimelineSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
});

export const campaignAttributionSchema = z.object({
  campaignId: z.number().int().nullable(),
  campaignName: z.string(),
  touchCount: z.number().int(),
  convertedLeads: z.number().int(),
  dealRevenueCents: z.number().int(),
  roi: z.number(),
});

// ─── Org Insights ─────────────────────────────────────────────────────────────

export interface OrgHierarchyNodeType {
  id: number;
  name: string;
  industry: string | null;
  healthScore: number | null;
  parentId: number | null;
  children: OrgHierarchyNodeType[];
}

export const orgHierarchyNodeSchema: z.ZodType<OrgHierarchyNodeType> = z.lazy(() =>
  z.object({
    id: z.number().int(),
    name: z.string(),
    industry: z.string().nullable(),
    healthScore: z.number().nullable(),
    parentId: z.number().int().nullable(),
    children: z.array(orgHierarchyNodeSchema),
  }),
);

export const orgRollupSchema = z.object({
  totalContacts: z.number().int(),
  totalDeals: z.number().int(),
  openDeals: z.number().int(),
  totalDealValue: z.number(),
  totalLeads: z.number().int(),
});

export const orgTimelineEventSchema = z.object({
  id: z.string(),
  date: z.string(),
  type: z.enum(["contact_created", "deal_created", "lead_linked", "note_added"]),
  description: z.string(),
  entityId: z.number().int(),
});

export const orgTimelineSchema = z.array(orgTimelineEventSchema);

export const orgRelatedLeadSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  status: z.string(),
  priority: z.string(),
  company: z.string().nullable(),
  source: z.string(),
  createdAt: wireDate(),
});

export const orgRelatedLeadsSchema = z.array(orgRelatedLeadSchema);

export const orgMergeResultSchema = z.object({
  success: z.literal(true),
  survivorId: z.number().int(),
  mergedId: z.number().int(),
  partyMergeId: z.string(),
  conflicts: z.unknown(),
});

export { successSchema };
